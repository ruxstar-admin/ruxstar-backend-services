const User = require('../models/User');
const cashfree = require('../utils/cashfree');

const vid = (userId, step) => `kyc_${String(userId).slice(-8)}_${step}_${Date.now()}`;

const MAX_SELFIE_BYTES = 5 * 1024 * 1024; // Cashfree face-match limit per image

const parseSelfie = (imageBase64) => {
  const raw = String(imageBase64).replace(/^data:image\/\w+;base64,/, '').trim();
  if (!raw) throw Object.assign(new Error('image required (base64 JPEG)'), { status: 400 });
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw Object.assign(new Error('invalid image data'), { status: 400 });
  if (buffer.length > MAX_SELFIE_BYTES) {
    throw Object.assign(new Error('selfie too large (max 5MB); reduce camera resolution or JPEG quality'), {
      status: 413,
    });
  }
  return buffer;
};

const defaultKyc = () => ({ status: 'pending', aadhaar: {}, pan: {}, face: {} });

const getKyc = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return null;
  return user.vendorProfile?.kyc || defaultKyc();
};

const stepsDone = (kyc) => ['aadhaar', 'pan', 'face'].every((s) => kyc[s]?.status === 'verified');

const computeStatus = (kyc) => {
  if (kyc.status === 'verified' || kyc.status === 'rejected') return kyc.status;
  if (stepsDone(kyc)) return 'pending_review';
  if (kyc.aadhaar?.status || kyc.pan?.status || kyc.face?.status) return 'in_progress';
  return 'pending';
};

const saveKyc = async (userId, kyc) => {
  const user = await User.findById(userId);
  if (!user) return null;
  kyc.status = computeStatus(kyc);
  const vendorProfile = { ...(user.vendorProfile || {}), kyc };
  return User.updateById(userId, { vendorProfile });
};

const sanitizeKyc = (kyc) => {
  if (!kyc) return kyc;
  const { aadhaar, ...rest } = kyc;
  if (!aadhaar) return kyc;
  const { photoBase64, ...aadhaarSafe } = aadhaar;
  return { ...rest, aadhaar: aadhaarSafe };
};

const startAadhaar = async (userId, { redirectUrl, userFlow = 'signup' }) => {
  const verificationId = vid(userId, 'aadhaar');
  const data = await cashfree.postJson('/digilocker', {
    verification_id: verificationId,
    document_requested: ['AADHAAR'],
    redirect_url: redirectUrl,
    user_flow: userFlow,
  });

  const kyc = await getKyc(userId);
  kyc.aadhaar = { status: 'pending', verificationId, referenceId: data.reference_id };
  delete kyc.rejectionReason;
  if (kyc.status === 'rejected') kyc.status = 'pending';
  await saveKyc(userId, kyc);

  return { url: data.url, verificationId, status: data.status };
};

const syncAadhaar = async (userId) => {
  const kyc = await getKyc(userId);
  const { verificationId } = kyc.aadhaar || {};
  if (!verificationId) return { status: 'not_started' };

  const status = await cashfree.getJson(`/digilocker?verification_id=${verificationId}`);

  if (status.status === 'CONSENT_DENIED') {
    kyc.aadhaar = { ...kyc.aadhaar, status: 'failed', reason: 'consent_denied' };
    await saveKyc(userId, kyc);
    return { status: 'failed', reason: 'consent_denied' };
  }

  if (status.status === 'EXPIRED') {
    kyc.aadhaar = { ...kyc.aadhaar, status: 'failed', reason: 'expired' };
    await saveKyc(userId, kyc);
    return { status: 'failed', reason: 'expired' };
  }

  if (status.status !== 'AUTHENTICATED' || !status.document_consent?.includes('AADHAAR')) {
    return { status: 'pending', digilockerStatus: status.status };
  }

  const doc = await cashfree.getJson(`/digilocker/document/AADHAAR?verification_id=${verificationId}`);
  if (doc.status !== 'SUCCESS') {
    return { status: 'pending', digilockerStatus: doc.status };
  }

  kyc.aadhaar = {
    status: 'verified',
    verificationId,
    referenceId: doc.reference_id,
    name: doc.name,
    uid: doc.uid,
    verifiedAt: new Date(),
    photoBase64: doc.photo_link,
  };
  await saveKyc(userId, kyc);

  return {
    status: 'verified',
    aadhaar: { name: doc.name, uid: doc.uid, dob: doc.dob, gender: doc.gender },
  };
};

const verifyPan = async (userId, { pan, name }) => {
  if (!pan) throw Object.assign(new Error('pan required'), { status: 400 });

  const kyc = await getKyc(userId);
  if (kyc.aadhaar?.status !== 'verified') {
    throw Object.assign(new Error('complete aadhaar verification first'), { status: 400 });
  }

  const data = await cashfree.postJson('/pan', {
    pan: pan.toUpperCase(),
    name: name || kyc.aadhaar.name,
  });

  if (!data.valid || data.pan_status !== 'VALID') {
    kyc.pan = { status: 'failed', pan: pan.toUpperCase(), message: data.message };
    await saveKyc(userId, kyc);
    throw Object.assign(new Error(data.message || 'invalid PAN'), { status: 400 });
  }

  kyc.pan = {
    status: 'verified',
    pan: data.pan,
    registeredName: data.registered_name,
    nameMatchResult: data.name_match_result,
    verifiedAt: new Date(),
  };
  await saveKyc(userId, kyc);

  return {
    status: 'verified',
    pan: data.pan,
    registeredName: data.registered_name,
    nameMatchResult: data.name_match_result,
  };
};

const verifyFace = async (userId, imageBase64) => {
  const kyc = await getKyc(userId);
  if (kyc.aadhaar?.status !== 'verified' || !kyc.aadhaar.photoBase64) {
    throw Object.assign(new Error('complete aadhaar verification first'), { status: 400 });
  }
  if (kyc.pan?.status !== 'verified') {
    throw Object.assign(new Error('complete PAN verification first'), { status: 400 });
  }

  const selfie = parseSelfie(imageBase64);
  const aadhaarPhoto = Buffer.from(kyc.aadhaar.photoBase64, 'base64');
  const verificationId = vid(userId, 'face');

  const liveness = await cashfree.postMultipart(
    '/face-liveness',
    { verification_id: verificationId },
    [{ name: 'image', buffer: selfie, filename: 'selfie.jpg', mime: 'image/jpeg' }],
  );

  if (!liveness.liveness || liveness.status !== 'SUCCESS') {
    kyc.face = { status: 'failed', reason: liveness.status || 'not_live' };
    await saveKyc(userId, kyc);
    throw Object.assign(new Error('face liveness check failed'), { status: 400, details: liveness.status });
  }

  const match = await cashfree.postMultipart(
    '/face-match',
    { verification_id: `${verificationId}_match`, threshold: '0.75' },
    [
      { name: 'first_image', buffer: selfie, filename: 'selfie.jpg', mime: 'image/jpeg' },
      { name: 'second_image', buffer: aadhaarPhoto, filename: 'aadhaar.jpg', mime: 'image/jpeg' },
    ],
  );

  if (match.face_match_result !== 'YES') {
    kyc.face = { status: 'failed', reason: 'face_mismatch', score: match.face_match_score };
    await saveKyc(userId, kyc);
    throw Object.assign(new Error('face does not match aadhaar photo'), { status: 400 });
  }

  kyc.face = { status: 'verified', livenessScore: liveness.liveness_score, matchScore: match.face_match_score, verifiedAt: new Date() };
  delete kyc.aadhaar.photoBase64;
  await saveKyc(userId, kyc);

  return { status: 'verified', livenessScore: liveness.liveness_score, matchScore: match.face_match_score };
};

const listForAdmin = async (status) => {
  const filter = { roles: 'vendor', 'vendorProfile.kyc': { $exists: true } };
  if (status) filter['vendorProfile.kyc.status'] = status;
  const users = await User.list(filter);
  return users.map((u) => ({
    id: String(u._id),
    name: u.name,
    mobile: u.mobile,
    businessName: u.vendorProfile?.businessName,
    kyc: sanitizeKyc(u.vendorProfile?.kyc),
  }));
};

const getForAdmin = async (userId) => {
  const user = await User.findById(userId);
  if (!user?.roles?.includes('vendor')) return null;
  return {
    id: String(user._id),
    name: user.name,
    mobile: user.mobile,
    businessName: user.vendorProfile?.businessName,
    kyc: sanitizeKyc(user.vendorProfile?.kyc),
  };
};

const review = async (userId, { action, reason }) => {
  const kyc = await getKyc(userId);
  if (kyc.status !== 'pending_review') {
    throw Object.assign(new Error('kyc not pending review'), { status: 400 });
  }
  if (action === 'approve') {
    kyc.status = 'verified';
    kyc.reviewedAt = new Date();
    delete kyc.rejectionReason;
  } else if (action === 'reject') {
    kyc.status = 'rejected';
    kyc.rejectionReason = reason || 'rejected by admin';
    kyc.reviewedAt = new Date();
  } else {
    throw Object.assign(new Error('action must be approve or reject'), { status: 400 });
  }
  await saveKyc(userId, kyc);
  return sanitizeKyc(kyc);
};

const ruxstarIdFor = (userId) => {
  const hex = String(userId).replace(/[^a-f0-9]/gi, '').toUpperCase();
  const tail = hex.slice(-8).padStart(8, '0');
  return `RUX-${tail.slice(0, 4)}-${tail.slice(4, 8)}`;
};

const maskAadhaar = (uid) =>
  typeof uid === 'string' && uid.length >= 4 ? `XXXX XXXX ${uid.slice(-4)}` : null;

const maskPan = (pan) =>
  typeof pan === 'string' && pan.length >= 4 ? `${pan.slice(0, 2)}XXXX${pan.slice(-2)}` : null;

// Ruxstar Card payload — only meaningful once KYC is verified.
const getCard = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return null;

  const kyc = user.vendorProfile?.kyc;
  if (!kyc || kyc.status !== 'verified') {
    return { status: kyc?.status || 'pending', card: null };
  }

  return {
    status: 'verified',
    card: {
      ruxstarId: ruxstarIdFor(userId),
      name: kyc.aadhaar?.name || kyc.pan?.registeredName || user.name || null,
      mobile: user.mobile || null,
      aadhaar: maskAadhaar(kyc.aadhaar?.uid),
      pan: maskPan(kyc.pan?.pan),
      memberSince: kyc.reviewedAt
        ? new Date(kyc.reviewedAt).toISOString()
        : kyc.aadhaar?.verifiedAt
          ? new Date(kyc.aadhaar.verifiedAt).toISOString()
          : null,
    },
  };
};

module.exports = { getKyc, startAadhaar, syncAadhaar, verifyPan, verifyFace, listForAdmin, getForAdmin, review, sanitizeKyc, getCard };

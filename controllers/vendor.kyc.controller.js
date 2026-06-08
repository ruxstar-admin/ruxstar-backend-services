const kycService = require('../services/vendor.kyc.service');

const publicKyc = (kyc) => {
  const { aadhaar, pan, face, status, rejectionReason } = kyc;
  return {
    status,
    rejectionReason: rejectionReason || null,
    aadhaar: aadhaar?.status ? { status: aadhaar.status, name: aadhaar.name, uid: aadhaar.uid } : { status: 'not_started' },
    pan: pan?.status ? { status: pan.status, pan: pan.pan, registeredName: pan.registeredName } : { status: 'not_started' },
    face: face?.status ? { status: face.status } : { status: 'not_started' },
  };
};

exports.status = async (req, res) => {
  const kyc = await kycService.getKyc(req.user.id);
  if (!kyc) return res.status(404).json({ message: 'vendor not found' });
  res.json({ kyc: publicKyc(kyc) });
};

exports.startAadhaar = async (req, res) => {
  const redirectUrl = req.body?.redirectUrl || process.env.KYC_REDIRECT_URL;
  if (!redirectUrl?.startsWith('https://')) {
    return res.status(400).json({ message: 'redirectUrl required (must start with https)' });
  }
  try {
    const result = await kycService.startAadhaar(req.user.id, {
      redirectUrl,
      userFlow: req.body?.userFlow,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message, details: err.data });
  }
};

exports.syncAadhaar = async (req, res) => {
  try {
    const result = await kycService.syncAadhaar(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message, details: err.data });
  }
};

exports.verifyPan = async (req, res) => {
  try {
    const result = await kycService.verifyPan(req.user.id, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message, details: err.data });
  }
};

exports.verifyFace = async (req, res) => {
  try {
    const result = await kycService.verifyFace(req.user.id, req.body?.image);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message, details: err.details || err.data });
  }
};

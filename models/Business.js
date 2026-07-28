const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');
const { BUSINESS_STATUS } = require('../constants/businessStatus');

const collection = () => getDb().collection('businesses');

const toObjectId = (id) => new ObjectId(String(id));

/** Exclude heavy base64 blobs from MongoDB reads (saves DB + memory bandwidth). */
const WITHOUT_PHOTO_DATA = { 'setup.photos.data': 0 };

const LIST_PUBLIC_PROJECTION = {
  name: 1,
  typeLabel: 1,
  categoryLabel: 1,
  module: 1,
  address: 1,
  addressParts: 1,
  description: 1,
  thumbnailUrl: 1,
  thumbnailPhotoId: 1,
  vendorId: 1,
  'setup.pricePerSlot': 1,
  'setup.slotMinutes': 1,
  'setup.bookingMode': 1,
  'setup.maxGuests': 1,
  'setup.resources': 1,
  'setup.services': 1,
  'setup.staff': 1,
  'setup.bufferMinutes': 1,
  'setup.photos.id': 1,
  'setup.photos.url': 1,
  'setup.photos.storageKey': 1,
  'setup.printProfile': 1,
  'setup.commerceProfile': 1,
  createdAt: 1,
  status: 1,
  setupComplete: 1,
  suspended: 1,
};

const sanitize = (doc) => {
  if (!doc) return doc;
  const { vendorId, ...rest } = doc;
  return {
    ...rest,
    vendorId: vendorId ? String(vendorId) : undefined,
    suspended: doc.suspended === true,
  };
};

const findOpts = ({ withPhotoData = true } = {}) =>
  withPhotoData ? {} : { projection: WITHOUT_PHOTO_DATA };

const listByVendor = async (vendorId, { withPhotoData = false } = {}) => {
  const rows = await collection()
    .find({ vendorId: toObjectId(vendorId) }, findOpts({ withPhotoData }))
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map(sanitize);
};

const findByIdForVendor = async (id, vendorId, { withPhotoData = true } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    findOpts({ withPhotoData }),
  );
  return sanitize(doc);
};

const findLiveById = async (id, { withPhotoData = false } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id), status: BUSINESS_STATUS.LIVE, setupComplete: true, suspended: { $ne: true } },
    findOpts({ withPhotoData }),
  );
  return sanitize(doc);
};

/** Setup-complete listing for public browse — includes shops taken offline. */
const findPublicById = async (id, { withPhotoData = false } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id), setupComplete: true, suspended: { $ne: true } },
    findOpts({ withPhotoData }),
  );
  return sanitize(doc);
};

const listLivePublic = async ({ module, modules, includeOffline = false } = {}) => {
  const filter = {
    setupComplete: true,
    suspended: { $ne: true },
  };
  if (!includeOffline) filter.status = BUSINESS_STATUS.LIVE;
  if (module) filter.module = module;
  else if (Array.isArray(modules) && modules.length) filter.module = { $in: modules };

  const rows = await collection()
    .find(filter, { projection: LIST_PUBLIC_PROJECTION })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  return rows.map(sanitize);
};

const LIVE_PRINT_PROJECTION = {
  name: 1,
  vendorId: 1,
  module: 1,
  status: 1,
  setupComplete: 1,
  thumbnailUrl: 1,
  address: 1,
  addressParts: 1,
  'setup.printProfile': 1,
};

// Live print-on-demand businesses that serve a given category (and optionally a
// city). Used to broadcast an open order to eligible vendors.
const listLivePrintForCategory = async (categoryId, city, { includeOffline = false } = {}) => {
  const filter = {
    setupComplete: true,
    suspended: { $ne: true },
    module: 'print',
    'setup.printProfile.serviceCategories': String(categoryId),
  };
  if (!includeOffline) filter.status = BUSINESS_STATUS.LIVE;
  if (city) {
    filter.$or = [
      { 'setup.printProfile.serveAll': true },
      { 'setup.printProfile.cities': String(city) },
    ];
  }
  const rows = await collection().find(filter, { projection: LIVE_PRINT_PROJECTION }).toArray();
  return rows.map(sanitize);
};

// A vendor's own live print businesses — used to decide eligibility to accept.
const listLivePrintByVendor = async (vendorId) => {
  const rows = await collection()
    .find(
      {
        vendorId: toObjectId(vendorId),
        status: BUSINESS_STATUS.LIVE,
        setupComplete: true,
        suspended: { $ne: true },
        module: 'print',
      },
      { projection: LIVE_PRINT_PROJECTION },
    )
    .toArray();
  return rows.map(sanitize);
};

const insert = async (vendorId, data) => {
  const now = new Date();
  const doc = {
    vendorId: toObjectId(vendorId),
    ...data,
    status: BUSINESS_STATUS.DRAFT,
    setupComplete: false,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(doc);
  return sanitize({ _id: insertedId, ...doc });
};

const updateForVendor = async (id, vendorId, patch) => {
  if (!ObjectId.isValid(String(id))) return null;
  const result = await collection().findOneAndUpdate(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return sanitize(result?.value ?? result);
};

const deleteForVendor = async (id, vendorId) => {
  if (!ObjectId.isValid(String(id))) return false;
  const { deletedCount } = await collection().deleteOne({
    _id: toObjectId(id),
    vendorId: toObjectId(vendorId),
  });
  return deletedCount > 0;
};

const findSetupPhoto = async (businessId, photoId) => {
  if (!ObjectId.isValid(String(businessId)) || !photoId) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(businessId), 'setup.photos.id': String(photoId) },
    { projection: { 'setup.photos.$': 1 } },
  );
  return doc?.setup?.photos?.[0] ?? null;
};

const countByVendor = (vendorId) =>
  collection().countDocuments({ vendorId: toObjectId(vendorId) });

// ── Admin ──

// Global, paginated list with optional filters/search. Excludes heavy blobs.
const listAllAdmin = async ({ status, module, suspended, vendorId, search, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (module) filter.module = module;
  if (suspended === true) filter.suspended = true;
  if (suspended === false) filter.suspended = { $ne: true };
  if (vendorId && ObjectId.isValid(String(vendorId))) filter.vendorId = toObjectId(vendorId);
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { address: rx }, { typeLabel: rx }, { categoryLabel: rx }];
  }
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    collection()
      .find(filter, { projection: WITHOUT_PHOTO_DATA })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .toArray(),
    collection().countDocuments(filter),
  ]);
  return { items: rows.map(sanitize), total };
};

const findByIdAny = async (id, { withPhotoData = false } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne({ _id: toObjectId(id) }, findOpts({ withPhotoData }));
  return sanitize(doc);
};

const setSuspended = async (id, suspended, reason) => {
  if (!ObjectId.isValid(String(id))) return null;
  const $set = { suspended: suspended === true, updatedAt: new Date() };
  if (suspended) {
    $set.suspendedAt = new Date();
    $set.suspendedReason = reason || 'suspended by admin';
  } else {
    $set.suspendedReason = null;
    $set.suspendedAt = null;
  }
  const result = await collection().findOneAndUpdate(
    { _id: toObjectId(id) },
    { $set },
    { returnDocument: 'after', projection: WITHOUT_PHOTO_DATA },
  );
  return sanitize(result?.value ?? result);
};

const countByStatus = async () => {
  const rows = await collection()
    .aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          live: { $sum: { $cond: [{ $eq: ['$status', BUSINESS_STATUS.LIVE] }, 1, 0] } },
          draft: { $sum: { $cond: [{ $ne: ['$status', BUSINESS_STATUS.LIVE] }, 1, 0] } },
          suspended: { $sum: { $cond: [{ $eq: ['$suspended', true] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  return rows[0] || { total: 0, live: 0, draft: 0, suspended: 0 };
};

const countBusinessesByVendorIds = async (vendorIds) => {
  const oids = [...new Set(vendorIds)]
    .filter((id) => id && ObjectId.isValid(String(id)))
    .map((id) => toObjectId(id));
  if (!oids.length) return {};
  const rows = await collection()
    .aggregate([
      { $match: { vendorId: { $in: oids } } },
      { $group: { _id: '$vendorId', count: { $sum: 1 } } },
    ])
    .toArray();
  return Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
};

const ensureIndexes = async () => {
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
  await collection().createIndex({ status: 1, setupComplete: 1, module: 1, createdAt: -1 });
};

module.exports = {
  sanitize,
  listByVendor,
  findByIdForVendor,
  findLiveById,
  findPublicById,
  listLivePublic,
  insert,
  updateForVendor,
  deleteForVendor,
  countByVendor,
  ensureIndexes,
  findSetupPhoto,
  listLivePrintForCategory,
  listLivePrintByVendor,
  listAllAdmin,
  findByIdAny,
  setSuspended,
  countByStatus,
  countBusinessesByVendorIds,
};

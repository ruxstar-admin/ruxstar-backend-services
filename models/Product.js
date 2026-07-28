const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const collection = () => getDb().collection('products');

const toObjectId = (id) => new ObjectId(String(id));

const WITHOUT_PHOTO_DATA = { 'photos.data': 0 };

const iso = (d) => (d ? d.toISOString?.() ?? d : null);

const sanitize = (doc, { withPhotoData = false } = {}) => {
  if (!doc) return doc;
  const photos = Array.isArray(doc.photos)
    ? doc.photos.map((p) => {
        const base = {
          id: p.id,
          url: p.url || null,
          storageKey: p.storageKey || null,
          mimeType: p.mimeType || null,
        };
        if (withPhotoData && p.data) {
          return { ...base, dataUrl: `data:${p.mimeType || 'image/jpeg'};base64,${p.data}` };
        }
        return base;
      })
    : [];
  return {
    id: String(doc._id),
    businessId: String(doc.businessId),
    vendorId: String(doc.vendorId),
    name: doc.name || '',
    description: doc.description || '',
    price: typeof doc.price === 'number' ? doc.price : 0,
    stock: typeof doc.stock === 'number' ? doc.stock : 0,
    active: doc.active !== false,
    photos,
    coverUrl: photos[0]?.url || null,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
};

const ensureIndexes = async () => {
  await collection().createIndex({ businessId: 1, active: 1, createdAt: -1 });
  await collection().createIndex({ vendorId: 1, createdAt: -1 });
};

const insert = async (doc) => {
  const now = new Date();
  const row = {
    businessId: toObjectId(doc.businessId),
    vendorId: toObjectId(doc.vendorId),
    name: doc.name,
    description: doc.description || '',
    price: doc.price,
    stock: doc.stock,
    active: doc.active !== false,
    photos: doc.photos || [],
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await collection().insertOne(row);
  return sanitize({ _id: insertedId, ...row });
};

const findById = async (id, { withPhotoData = false } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id) },
    withPhotoData ? {} : { projection: WITHOUT_PHOTO_DATA },
  );
  return sanitize(doc, { withPhotoData });
};

const findByIdForVendor = async (id, vendorId, { withPhotoData = false } = {}) => {
  if (!ObjectId.isValid(String(id))) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    withPhotoData ? {} : { projection: WITHOUT_PHOTO_DATA },
  );
  return sanitize(doc, { withPhotoData });
};

const listByBusiness = async (businessId, { activeOnly = false, withPhotoData = false } = {}) => {
  const filter = { businessId: toObjectId(businessId) };
  if (activeOnly) filter.active = { $ne: false };
  const rows = await collection()
    .find(filter, withPhotoData ? {} : { projection: WITHOUT_PHOTO_DATA })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((r) => sanitize(r, { withPhotoData }));
};

const countByBusiness = async (businessId, { activeOnly = false, inStock = false } = {}) => {
  const filter = { businessId: toObjectId(businessId) };
  if (activeOnly) filter.active = { $ne: false };
  if (inStock) filter.stock = { $gt: 0 };
  return collection().countDocuments(filter);
};

const updateForVendor = async (id, vendorId, patch) => {
  if (!ObjectId.isValid(String(id))) return null;
  const result = await collection().findOneAndUpdate(
    { _id: toObjectId(id), vendorId: toObjectId(vendorId) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: 'after', projection: WITHOUT_PHOTO_DATA },
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

const findPhoto = async (productId, photoId) => {
  if (!ObjectId.isValid(String(productId)) || !photoId) return null;
  const doc = await collection().findOne(
    { _id: toObjectId(productId), 'photos.id': String(photoId) },
    { projection: { 'photos.$': 1 } },
  );
  return doc?.photos?.[0] ?? null;
};

/** Atomic stock decrement for paid lines. Returns false if any line would go negative. */
const decrementStock = async (lines) => {
  for (const line of lines) {
    const result = await collection().findOneAndUpdate(
      {
        _id: toObjectId(line.productId),
        stock: { $gte: line.quantity },
        active: { $ne: false },
      },
      { $inc: { stock: -line.quantity }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    const updated = result?.value ?? result;
    if (!updated) return false;
  }
  return true;
};

const restoreStock = async (lines) => {
  for (const line of lines) {
    await collection().updateOne(
      { _id: toObjectId(line.productId) },
      { $inc: { stock: line.quantity }, $set: { updatedAt: new Date() } },
    );
  }
};

module.exports = {
  sanitize,
  ensureIndexes,
  insert,
  findById,
  findByIdForVendor,
  listByBusiness,
  countByBusiness,
  updateForVendor,
  deleteForVendor,
  findPhoto,
  decrementStock,
  restoreStock,
};

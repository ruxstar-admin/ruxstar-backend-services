const { randomUUID } = require('crypto');
const Business = require('../models/Business');
const Product = require('../models/Product');
const photoStorage = require('./photoStorage.service');
const {
  MAX_PRODUCTS_PER_BUSINESS,
  MAX_PRODUCT_PHOTOS,
  MAX_PRODUCT_PHOTO_BYTES,
} = require('../constants/commerce');
const { BUSINESS_STATUS } = require('../constants/businessStatus');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const assertCommerceBusiness = (business) => {
  if (!business || business.module !== 'commerce') {
    throw bad('this business is not a commerce shop');
  }
};

const getOwnedCommerce = async (businessId, vendorId) => {
  const business = await Business.findByIdForVendor(businessId, vendorId, {
    withPhotoData: false,
  });
  if (!business) throw bad('business not found', 404);
  assertCommerceBusiness(business);
  return business;
};

const parseImage = (imageBase64) => {
  const match = String(imageBase64).match(/^data:(image\/\w+);base64,(.+)$/);
  const mimeType = match?.[1] || 'image/jpeg';
  const raw = (match?.[2] ?? String(imageBase64)).replace(/^data:image\/\w+;base64,/, '').trim();
  if (!raw) throw bad('image required');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw bad('invalid image data');
  if (buffer.length > MAX_PRODUCT_PHOTO_BYTES) throw bad('image too large (max 3MB)', 413);
  if (!mimeType.startsWith('image/')) throw bad('only image uploads are allowed');
  return { mimeType, data: raw, buffer };
};

const photoUrl = (productId, photoId) => {
  const path = `/public/commerce/products/${productId}/photos/${photoId}`;
  const base = process.env.API_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  return base ? `${base}${path}` : `/api${path}`;
};

const buildPhotos = async (productId, images) => {
  const list = Array.isArray(images) ? images.slice(0, MAX_PRODUCT_PHOTOS) : [];
  const photos = [];
  for (const image of list) {
    const { mimeType, data, buffer } = parseImage(image);
    const id = randomUUID();
    const uploaded = await photoStorage.uploadBusinessPhoto(
      `products/${productId}`,
      id,
      buffer,
      mimeType,
    );
    photos.push({
      id,
      mimeType,
      ...(uploaded.storageKey
        ? { storageKey: uploaded.storageKey, url: uploaded.url }
        : { data, url: photoUrl(productId, id) }),
    });
  }
  return photos;
};

const syncActiveProductCount = async (businessId, vendorId) => {
  const count = await Product.countByBusiness(businessId, { activeOnly: true, inStock: false });
  const business = await Business.findByIdForVendor(businessId, vendorId, {
    withPhotoData: false,
  });
  if (!business) return;
  const setup = business.setup || {};
  const commerceProfile = { ...(setup.commerceProfile || {}), activeProductCount: count };
  await Business.updateForVendor(businessId, vendorId, {
    setup: { ...setup, commerceProfile },
  });
};

const normalizeProductInput = (body) => {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw bad('product name is required');
  const description = String(body.description ?? '').trim().slice(0, 1000);
  const price = Math.round(Number(body.price));
  if (!Number.isFinite(price) || price < 1) throw bad('price must be at least ₹1');
  const stock = Math.round(Number(body.stock));
  if (!Number.isFinite(stock) || stock < 0) throw bad('stock must be 0 or more');
  const active = body.active === undefined ? true : body.active !== false;
  return { name, description, price, stock, active };
};

const createProduct = async (businessId, vendorId, body) => {
  await getOwnedCommerce(businessId, vendorId);
  const count = await Product.countByBusiness(businessId);
  if (count >= MAX_PRODUCTS_PER_BUSINESS) {
    throw bad(`you can list up to ${MAX_PRODUCTS_PER_BUSINESS} products`);
  }
  const input = normalizeProductInput(body);
  const tempId = randomUUID();
  const photos = await buildPhotos(tempId, body.images || body.photos || []);
  const product = await Product.insert({
    businessId,
    vendorId,
    ...input,
    photos,
  });
  // Fix URLs that used temp id when falling back to API path without GCS.
  if (photos.some((p) => p.url && p.url.includes(tempId)) && !photos[0]?.storageKey) {
    const fixed = photos.map((p) => ({
      ...p,
      url: p.data ? photoUrl(product.id, p.id) : p.url,
    }));
    await Product.updateForVendor(product.id, vendorId, { photos: fixed });
    product.photos = fixed.map(({ id, url, storageKey, mimeType }) => ({
      id,
      url,
      storageKey,
      mimeType,
    }));
    product.coverUrl = fixed[0]?.url || null;
  }
  await syncActiveProductCount(businessId, vendorId);
  return { product };
};

const updateProduct = async (businessId, vendorId, productId, body) => {
  await getOwnedCommerce(businessId, vendorId);
  const existing = await Product.findByIdForVendor(productId, vendorId, { withPhotoData: true });
  if (!existing || existing.businessId !== String(businessId)) {
    throw bad('product not found', 404);
  }
  const input = normalizeProductInput({
    name: body.name ?? existing.name,
    description: body.description ?? existing.description,
    price: body.price ?? existing.price,
    stock: body.stock ?? existing.stock,
    active: body.active ?? existing.active,
  });

  let photos;
  if (body.images || body.photos) {
    photos = await buildPhotos(productId, body.images || body.photos);
  }

  const updated = await Product.updateForVendor(productId, vendorId, {
    ...input,
    ...(photos ? { photos } : {}),
  });
  await syncActiveProductCount(businessId, vendorId);
  return { product: updated };
};

const deleteProduct = async (businessId, vendorId, productId) => {
  await getOwnedCommerce(businessId, vendorId);
  const existing = await Product.findByIdForVendor(productId, vendorId);
  if (!existing || existing.businessId !== String(businessId)) {
    throw bad('product not found', 404);
  }
  await Product.deleteForVendor(productId, vendorId);
  await syncActiveProductCount(businessId, vendorId);
  return { ok: true };
};

const listVendorProducts = async (businessId, vendorId) => {
  await getOwnedCommerce(businessId, vendorId);
  const products = await Product.listByBusiness(businessId);
  return { products };
};

const listPublicProducts = async (businessId) => {
  const business = await Business.findPublicById(businessId, { withPhotoData: false });
  if (!business || business.module !== 'commerce') throw bad('shop not found', 404);
  const profile = business.setup?.commerceProfile || {};
  const open =
    business.status === BUSINESS_STATUS.LIVE &&
    business.setupComplete === true &&
    profile.acceptingOrders !== false;
  // Sold-out items stay in the list so the shop still looks stocked; the
  // storefront marks them unavailable instead of silently dropping them.
  const products = await Product.listByBusiness(businessId, { activeOnly: true });
  return {
    shop: {
      id: String(business._id ?? business.id),
      name: business.name,
      address: business.address || '',
      description: business.description || '',
      thumbnailUrl: business.thumbnailUrl || '',
      notes: profile.notes || '',
      minOrderValue: profile.minOrderValue || 0,
      acceptingOrders: open,
      productCount: products.length,
      inStockCount: products.filter((p) => p.stock > 0).length,
    },
    products,
  };
};

const listLiveShops = async () => {
  const rows = await Business.listLivePublic({ module: 'commerce', includeOffline: true });
  const shops = [];
  for (const biz of rows) {
    const profile = biz.setup?.commerceProfile || {};
    const businessId = String(biz._id);
    const [productCount, inStockCount] = await Promise.all([
      Product.countByBusiness(businessId, { activeOnly: true }),
      Product.countByBusiness(businessId, { activeOnly: true, inStock: true }),
    ]);
    // A shop with nothing listed at all has nothing to show. Running out of
    // stock is not the same thing — that shop stays listed as sold out.
    if (productCount < 1) continue;
    const open =
      biz.status === BUSINESS_STATUS.LIVE &&
      biz.setupComplete === true &&
      profile.acceptingOrders !== false;
    shops.push({
      id: businessId,
      name: biz.name,
      address: biz.address || '',
      description: biz.description || '',
      thumbnailUrl: biz.thumbnailUrl || '',
      notes: profile.notes || '',
      minOrderValue: profile.minOrderValue || 0,
      productCount,
      inStockCount,
      acceptingOrders: open,
    });
  }
  shops.sort(
    (a, b) =>
      Number(b.acceptingOrders) - Number(a.acceptingOrders) ||
      Number(b.inStockCount > 0) - Number(a.inStockCount > 0),
  );
  return { shops };
};

const getProductPhoto = async (productId, photoId) => {
  const photo = await Product.findPhoto(productId, photoId);
  if (!photo) return null;
  if (photo.storageKey) {
    const stream = photoStorage.openBusinessPhotoReadStream(photo.storageKey);
    if (stream) return { stream, mimeType: photo.mimeType || 'image/jpeg' };
  }
  if (photo.data) {
    return { buffer: Buffer.from(photo.data, 'base64'), mimeType: photo.mimeType || 'image/jpeg' };
  }
  return null;
};

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  listVendorProducts,
  listPublicProducts,
  listLiveShops,
  getProductPhoto,
  syncActiveProductCount,
  assertCommerceBusiness,
};

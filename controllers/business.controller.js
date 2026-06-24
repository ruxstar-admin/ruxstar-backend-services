const Business = require('../models/Business');
const catalogService = require('../services/businessCatalog.service');
const setupService = require('../services/businessSetup.service');
const slotsService = require('../services/businessSlots.service');

const MAX_BUSINESSES = 25;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.list = async (req, res) => {
  const businesses = await Business.listByVendor(req.user.id);
  res.json({
    businesses: businesses.map((b) =>
      setupService.stripSetupPhotos(setupService.formatBusinessForClient(b)),
    ),
  });
};

exports.get = async (req, res) => {
  const business = await Business.findByIdForVendor(req.params.id, req.user.id);
  if (!business) return res.status(404).json({ message: 'business not found' });
  res.json({
    business: setupService.stripSetupPhotos(setupService.formatBusinessForClient(business)),
  });
};

exports.create = async (req, res) => {
  const name = str(req.body.name);
  const typeId = str(req.body.typeId);

  if (!name) return res.status(400).json({ message: 'business name is required' });
  if (!typeId) return res.status(400).json({ message: 'business type is required' });

  let resolved;
  try {
    resolved = await catalogService.resolveTypeForBusiness(typeId);
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }

  const { businessType, category } = resolved;

  const count = await Business.countByVendor(req.user.id);
  if (count >= MAX_BUSINESSES) {
    return res.status(400).json({ message: `you can add up to ${MAX_BUSINESSES} businesses` });
  }

  const description = str(req.body.description);
  if (!description) {
    return res.status(400).json({ message: 'business description is required' });
  }

  const thumbnail = str(req.body.thumbnail);

  const business = await Business.insert(req.user.id, {
    name,
    typeId: businessType.id,
    categoryId: category.id,
    typeLabel: businessType.label,
    categoryLabel: category.label,
    module: businessType.module,
    phone: str(req.body.phone),
    address: str(req.body.address),
    description,
    setup: setupService.defaultSetup({ bookingMode: req.body.bookingMode, typeId: businessType.id }),
  });

  if (thumbnail) {
    try {
      const withThumbnail = await setupService.setBusinessThumbnail(
        String(business._id ?? business.id),
        req.user.id,
        thumbnail,
      );
      return res.status(201).json({
        business: setupService.stripSetupPhotos(withThumbnail),
      });
    } catch (err) {
      await Business.deleteForVendor(String(business._id ?? business.id), req.user.id);
      return res.status(err.status || 500).json({ message: err.message });
    }
  }

  res.status(201).json({
    business: setupService.stripSetupPhotos(setupService.formatBusinessForClient(business)),
  });
};

exports.setThumbnail = handle(async (req, res) => {
  const image = req.body.image ?? req.body.thumbnail ?? req.body.photo;
  if (!image) return res.status(400).json({ message: 'image required' });
  const business = await setupService.setBusinessThumbnail(req.params.id, req.user.id, image);
  res.json({ business: setupService.stripSetupPhotos(business) });
});

exports.update = async (req, res) => {
  const patch = {};

  if (req.body.name !== undefined) {
    const name = str(req.body.name);
    if (!name) return res.status(400).json({ message: 'business name cannot be empty' });
    patch.name = name;
  }

  if (req.body.typeId !== undefined) {
    const typeId = str(req.body.typeId);
    if (!typeId) return res.status(400).json({ message: 'business type is required' });
    try {
      const { businessType, category } = await catalogService.resolveTypeForBusiness(typeId);
      patch.typeId = businessType.id;
      patch.categoryId = category.id;
      patch.typeLabel = businessType.label;
      patch.categoryLabel = category.label;
      patch.module = businessType.module;
    } catch (err) {
      return res.status(err.status || 400).json({ message: err.message });
    }
  }

  for (const key of ['phone', 'address', 'description']) {
    if (req.body[key] !== undefined) patch[key] = str(req.body[key]);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ message: 'no fields to update' });
  }

  const business = await Business.updateForVendor(req.params.id, req.user.id, patch);
  if (!business) return res.status(404).json({ message: 'business not found' });
  res.json({
    business: setupService.stripSetupPhotos(setupService.formatBusinessForClient(business)),
  });
};

exports.remove = async (req, res) => {
  const ok = await Business.deleteForVendor(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ message: 'business not found' });
  res.json({ ok: true });
};

exports.getSetup = handle(async (req, res) => {
  const business = await setupService.getSetup(req.params.id, req.user.id);
  res.json({ business });
});

exports.updateSetup = handle(async (req, res) => {
  const business = await setupService.updateSetup(req.params.id, req.user.id, req.body);
  res.json({ business });
});

exports.addSetupPhoto = handle(async (req, res) => {
  const image = req.body.image ?? req.body.photo;
  if (!image) return res.status(400).json({ message: 'image required' });
  const business = await setupService.addPhoto(req.params.id, req.user.id, image);
  res.json({ business });
});

exports.removeSetupPhoto = handle(async (req, res) => {
  const business = await setupService.removePhoto(
    req.params.id,
    req.user.id,
    req.params.photoId,
  );
  res.json({ business });
});

exports.syncSetupPhotos = handle(async (req, res) => {
  const images = Array.isArray(req.body.images) ? req.body.images : [];
  const removeIds = Array.isArray(req.body.removeIds) ? req.body.removeIds : [];
  const business = await setupService.syncPhotos(req.params.id, req.user.id, {
    images,
    removeIds,
  });
  res.json({ business });
});

exports.completeSetup = handle(async (req, res) => {
  const business = await setupService.completeSetup(req.params.id, req.user.id);
  res.json({ business });
});

exports.listSlots = handle(async (req, res) => {
  const payload = await slotsService.listSlots(req.params.id, req.user.id, req.query);
  res.json(payload);
});

exports.blockSlot = handle(async (req, res) => {
  const payload = await slotsService.blockSlot(req.params.id, req.user.id, req.body);
  res.json(payload);
});

exports.unblockSlot = handle(async (req, res) => {
  const payload = await slotsService.unblockSlot(req.params.id, req.user.id, req.body);
  res.json(payload);
});

exports.setSlotPrice = handle(async (req, res) => {
  const payload = await slotsService.setSlotPrice(req.params.id, req.user.id, req.body);
  res.json(payload);
});

exports.clearSlotPrice = handle(async (req, res) => {
  const payload = await slotsService.clearSlotPrice(req.params.id, req.user.id, req.body);
  res.json(payload);
});

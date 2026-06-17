const Business = require('../models/Business');
const catalogService = require('../services/businessCatalog.service');

const MAX_BUSINESSES = 25;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

exports.list = async (req, res) => {
  const businesses = await Business.listByVendor(req.user.id);
  res.json({ businesses });
};

exports.get = async (req, res) => {
  const business = await Business.findByIdForVendor(req.params.id, req.user.id);
  if (!business) return res.status(404).json({ message: 'business not found' });
  res.json({ business });
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

  const business = await Business.insert(req.user.id, {
    name,
    typeId: businessType.id,
    categoryId: category.id,
    typeLabel: businessType.label,
    categoryLabel: category.label,
    module: businessType.module,
    phone: str(req.body.phone),
    address: str(req.body.address),
    description: str(req.body.description),
  });

  res.status(201).json({ business });
};

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
  res.json({ business });
};

exports.remove = async (req, res) => {
  const ok = await Business.deleteForVendor(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ message: 'business not found' });
  res.json({ ok: true });
};

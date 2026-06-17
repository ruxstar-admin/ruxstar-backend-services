const catalogService = require('../services/businessCatalog.service');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.listCategories = handle(async (_req, res) => {
  const categories = await catalogService.listCategoriesAdmin();
  res.json({ categories });
});

exports.createCategory = handle(async (req, res) => {
  const category = await catalogService.createCategory(req.body);
  res.status(201).json({ category });
});

exports.updateCategory = handle(async (req, res) => {
  const category = await catalogService.updateCategory(req.params.id, req.body);
  res.json({ category });
});

exports.listTypes = handle(async (req, res) => {
  const types = await catalogService.listTypesAdmin(req.query.categoryId);
  res.json({ types });
});

exports.createType = handle(async (req, res) => {
  const type = await catalogService.createType(req.body);
  res.status(201).json({ type });
});

exports.updateType = handle(async (req, res) => {
  const type = await catalogService.updateType(req.params.id, req.body);
  res.json({ type });
});

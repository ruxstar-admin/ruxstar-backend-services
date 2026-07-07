const catalogService = require('../services/businessCatalog.service');
const { PRINT_CATEGORIES } = require('../constants/printCatalog');

exports.catalog = async (_req, res) => {
  const catalog = await catalogService.listCatalog();
  res.json(catalog);
};

exports.printCatalog = async (_req, res) => {
  res.json({ categories: PRINT_CATEGORIES });
};

const catalogService = require('../services/businessCatalog.service');

exports.catalog = async (_req, res) => {
  const catalog = await catalogService.listCatalog();
  res.json(catalog);
};

const { getDb } = require('../config/database');

module.exports = {
  collection: () => getDb().collection('users'),
};

const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI);

module.exports = {
  connect: () => client.connect(),
  ping: () => client.db().admin().ping(),
};

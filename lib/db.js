const { MongoClient } = require('mongodb');

cosole.log("DB URI:", process.env.MONGODB_URI);
const client = new MongoClient(process.env.MONGODB_URI);

module.exports = {
  connect: () => client.connect(),
  ping: () => client.db().admin().ping(),
};

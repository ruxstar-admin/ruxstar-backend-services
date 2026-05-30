const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI);
let db;

const connect = async () => {
  await client.connect();
  db = client.db();
};

const getDb = () => {
  if (!db) throw new Error('DB not connected');
  return db;
};

module.exports = { connect, getDb };

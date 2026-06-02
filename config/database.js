const { MongoClient } = require('mongodb');

let client;
let db;

const getClient = () => {
  if (!client) {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
    client = new MongoClient(process.env.MONGODB_URI);
  }
  return client;
};

const connect = async () => {
  await getClient().connect();
  db = getClient().db();
};

const getDb = () => {
  if (!db) throw new Error('DB not connected');
  return db;
};

module.exports = { connect, getDb };

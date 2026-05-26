const { MongoClient } = require('mongodb');
require('dotenv').config();
const client = new MongoClient(process.env.MONGODB_URI);
module.exports = {
  connect: () => client.connect()};

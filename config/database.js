const { MongoClient } = require('mongodb');

let client;
let db;
let transactionsSupported = false;

const getClient = () => {
  if (!client) {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
    client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE) || 20,
      minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE) || 0,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 10000,
      retryWrites: true,
    });
  }
  return client;
};

const connect = async () => {
  await getClient().connect();
  db = getClient().db();
  // Multi-document transactions require a replica set or mongos (Atlas always
  // qualifies). Standalone local mongod does not — detect once so the booking
  // flow can fall back to manual rollback in dev.
  try {
    const hello = await db.admin().command({ hello: 1 });
    transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    transactionsSupported = false;
  }
};

const getDb = () => {
  if (!db) throw new Error('DB not connected');
  return db;
};

const supportsTransactions = () => transactionsSupported;

// Runs `fn` inside a MongoDB transaction when the deployment supports it,
// passing the session so callers can make atomic multi-collection writes.
// On unsupported deployments it runs `fn(null)` and the caller is responsible
// for compensating writes.
const withTransaction = async (fn) => {
  if (!transactionsSupported) return fn(null);
  const session = getClient().startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { connect, getDb, getClient, supportsTransactions, withTransaction };

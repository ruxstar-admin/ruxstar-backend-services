const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDb } = require('../config/database');

const DISABLED_MESSAGE = 'Account disabled. Please contact admin.';

// Verifies the JWT, then (for real user tokens) re-checks the account against
// the database on every request. This makes admin disables and role changes
// take effect immediately instead of waiting for the 7-day token to expire.
module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'no token' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'invalid token' });
  }
  req.user = decoded;

  // Non-user tokens (e.g. the short-lived signup token) carry no id — nothing
  // to re-check, so let them through as before.
  if (!decoded?.id || !ObjectId.isValid(String(decoded.id))) return next();

  try {
    const user = await getDb()
      .collection('users')
      .findOne(
        { _id: new ObjectId(String(decoded.id)) },
        { projection: { status: 1, roles: 1, name: 1, 'vendorProfile.businessName': 1 } },
      );
    if (!user) return res.status(401).json({ message: 'invalid token' });
    if (user.status === 'disabled') return res.status(403).json({ message: DISABLED_MESSAGE });
    // Trust the DB roles over the (possibly stale) token roles.
    req.user.roles = user.roles || decoded.roles;
    req.currentUser = user;
    next();
  } catch {
    res.status(500).json({ message: 'auth check failed' });
  }
};

// One-off bootstrap for the first admin account (or additional staff).
//
// Usage:
//   node scripts/create-admin.js --mobile 9999999999 --name "Root Admin" --password "secret" [--role admin]
// Or via env:
//   ADMIN_MOBILE=9999999999 ADMIN_NAME="Root Admin" ADMIN_PASSWORD=secret node scripts/create-admin.js
//
// Roles: admin (default) or employee. Safe to re-run — it will promote an
// existing account to the role instead of creating a duplicate.

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const bcrypt = require('bcryptjs');
const db = require('../config/database');
const User = require('../models/User');
const ROLES = require('../constants/roles');

const parseArgs = () => {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
      out[name] = value;
    }
  }
  return out;
};

const run = async () => {
  const args = parseArgs();
  const mobile = args.mobile || process.env.ADMIN_MOBILE;
  const name = args.name || process.env.ADMIN_NAME;
  const password = args.password || process.env.ADMIN_PASSWORD;
  const role = (args.role || process.env.ADMIN_ROLE || ROLES.ADMIN).toLowerCase();

  if (!mobile || !name || !password) {
    console.error(
      'Missing required fields. Provide --mobile, --name and --password (or ADMIN_MOBILE/ADMIN_NAME/ADMIN_PASSWORD).',
    );
    process.exit(1);
  }
  if (![ROLES.ADMIN, ROLES.EMPLOYEE].includes(role)) {
    console.error(`Invalid role "${role}". Must be "admin" or "employee".`);
    process.exit(1);
  }

  await db.connect();
  try {
    const existing = await User.findByMobile(mobile);
    if (existing) {
      const result = await User.updateById(existing._id, { roles: [role], status: 'active' });
      const user = result?.value ?? result ?? existing;
      console.log(`Existing account ${User.normalize(mobile)} promoted to ${role}.`);
      console.log(`Member id: ${User.sanitize(user).refId}`);
    } else {
      const user = await User.insert({
        mobile: User.normalize(mobile),
        name,
        passwordHash: await bcrypt.hash(password, 10),
        roles: [role],
        mobileVerified: true,
        status: 'active',
        createdAt: new Date(),
      });
      console.log(`Created ${role} account for ${User.normalize(mobile)}.`);
      console.log(`Member id: ${User.sanitize(user).refId}`);
    }
  } catch (err) {
    console.error('Failed to create admin:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      await db.getClient().close();
    } catch {
      /* ignore */
    }
    process.exit(process.exitCode || 0);
  }
};

run();

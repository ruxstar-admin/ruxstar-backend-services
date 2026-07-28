// Backfills `addressParts` on businesses created before addresses were stored
// as structured fields. The parse is best-effort (pincode by pattern, state by
// name match, the segment before the state as the city) — a vendor editing
// their profile afterwards overwrites it with exact values.
//
// Usage:
//   node scripts/backfill-business-address.js [--dry]

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const db = require('../config/database');
const { parseAddress, composeAddress } = require('../utils/businessAddress');

const run = async () => {
  const dryRun = process.argv.includes('--dry');
  await db.connect();
  const businesses = db.getDb().collection('businesses');

  const cursor = businesses.find(
    { addressParts: { $exists: false }, address: { $nin: [null, ''] } },
    { projection: { address: 1 } },
  );

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for await (const doc of cursor) {
    scanned += 1;
    const parts = parseAddress(doc.address);
    if (!parts || !parts.city) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`${doc._id}: ${doc.address} -> ${JSON.stringify(parts)}`);
      updated += 1;
      continue;
    }
    await businesses.updateOne(
      { _id: doc._id },
      { $set: { addressParts: parts, address: composeAddress(parts), updatedAt: new Date() } },
    );
    updated += 1;
  }

  console.log(
    `${dryRun ? '[dry run] ' : ''}scanned ${scanned}, updated ${updated}, skipped ${skipped} (no city found).`,
  );
};

run()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.getClient().close();
    } catch {
      /* ignore */
    }
    process.exit(process.exitCode || 0);
  });

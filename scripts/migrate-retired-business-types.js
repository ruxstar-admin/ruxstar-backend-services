// Moves businesses that still point at a retired business type onto the type
// that replaced it. The six print-ish types were collapsed into a single
// "Print on demand" type; the old "Services & professionals" types have no
// replacement, so those are only reported — a human has to decide what they
// should become.
//
// Usage:
//   node scripts/migrate-retired-business-types.js [--dry]

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const db = require('../config/database');
const BusinessType = require('../models/BusinessType');
const BusinessCategory = require('../models/BusinessCategory');

// Retired type id -> replacement type id.
const TYPE_REPLACEMENTS = {
  custom_merch: 'print_shop',
  creator_merch: 'print_shop',
  corporate_printing: 'print_shop',
  event_printing: 'print_shop',
  branding_agency: 'print_shop',
};

// Retired with no equivalent in the current catalog.
const ORPHAN_TYPE_IDS = ['home_service', 'repair', 'local_pro'];

const run = async () => {
  const dryRun = process.argv.includes('--dry');
  await db.connect();
  const businesses = db.getDb().collection('businesses');

  let moved = 0;

  for (const [fromId, toId] of Object.entries(TYPE_REPLACEMENTS)) {
    const target = await BusinessType.findById(toId);
    if (!target) {
      console.warn(`skipping ${fromId}: replacement type "${toId}" is not seeded yet`);
      continue;
    }
    const category = await BusinessCategory.findById(target.categoryId);
    const patch = {
      typeId: toId,
      typeLabel: target.label,
      categoryId: target.categoryId,
      categoryLabel: category?.label ?? '',
      module: target.module,
      updatedAt: new Date(),
    };

    const count = await businesses.countDocuments({ typeId: fromId });
    if (count === 0) continue;

    if (dryRun) {
      console.log(`[dry run] ${count} business(es) on "${fromId}" would move to "${toId}"`);
    } else {
      const { modifiedCount } = await businesses.updateMany({ typeId: fromId }, { $set: patch });
      console.log(`${modifiedCount} business(es) moved from "${fromId}" to "${toId}"`);
    }
    moved += count;
  }

  const orphans = await businesses
    .find({ typeId: { $in: ORPHAN_TYPE_IDS } }, { projection: { name: 1, typeId: 1, status: 1 } })
    .toArray();

  if (orphans.length) {
    console.log(`\n${orphans.length} business(es) on a retired type with no replacement:`);
    for (const biz of orphans) {
      console.log(`  ${biz._id}  ${biz.typeId}  ${biz.status}  ${biz.name}`);
    }
    console.log('Reassign these manually from the admin catalog.');
  }

  console.log(`\n${dryRun ? '[dry run] ' : ''}${moved} business(es) migrated, ${orphans.length} need a manual decision.`);
};

run()
  .catch((err) => {
    console.error('Migration failed:', err.message);
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

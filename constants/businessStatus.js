// Business lifecycle. `draft` covers both "still onboarding" and "taken
// offline by the vendor"; only `live` + setupComplete is publicly bookable.
const BUSINESS_STATUS = {
  DRAFT: 'draft',
  LIVE: 'live',
};

const BUSINESS_STATUS_VALUES = Object.values(BUSINESS_STATUS);

module.exports = { BUSINESS_STATUS, BUSINESS_STATUS_VALUES };

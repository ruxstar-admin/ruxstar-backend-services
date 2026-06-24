require('dotenv').config();
const { connect } = require('./config/database');
const bookingService = require('./services/booking.service');

(async () => {
  await connect();
  const id = '6a3b8ee510e374e91c5b0a50';
  const biz = await bookingService.getPublicBusiness(id);
  console.log('bookingMode', biz.setup.bookingMode, 'services', biz.setup.services.length);

  const svcId = biz.setup.services[0]?.id;
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 5.5 * 3600 * 1000 + 6 * 86400000).toISOString().slice(0, 10);

  const payload = await bookingService.listPublicSlots(id, {
    from: today,
    to,
    serviceIds: svcId,
    staffId: biz.setup.staff[0]?.id,
  });
  const byDate = {};
  for (const s of payload.slots) {
    byDate[s.date] = (byDate[s.date] || 0) + 1;
    byDate[s.date + '_' + s.status] = (byDate[s.date + '_' + s.status] || 0) + 1;
  }
  console.log('total slots', payload.slots.length);
  console.log('by date/status', byDate);
  console.log('sample today', payload.slots.filter((s) => s.date === today).slice(0, 3));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

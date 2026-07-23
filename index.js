if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = require('./app');
const db = require('./config/database');
const Business = require('./models/Business');
const User = require('./models/User');
const Otp = require('./models/Otp');
const catalogService = require('./services/businessCatalog.service');
const slotsService = require('./services/businessSlots.service');
const bookingService = require('./services/booking.service');
const eventService = require('./services/event.service');
const printOrderService = require('./services/printOrder.service');
const paymentService = require('./services/payment.service');
const payoutService = require('./services/payout.service');
const supportService = require('./services/support.service');
const notificationService = require('./services/notification.service');

const port = process.env.PORT || 8080;

const ensureAllIndexes = async () => {
  const seed = await catalogService.seedIfEmpty();
  if (seed.seeded) {
    console.log(
      `Business catalog seeded (${seed.categories} categories, ${seed.types} types)`,
    );
  }
  await slotsService.ensureIndexes();
  await bookingService.ensureIndexes();
  await eventService.ensureIndexes();
  await printOrderService.ensureIndexes();
  await paymentService.ensureIndexes();
  await payoutService.ensureIndexes();
  await supportService.ensureIndexes();
  await notificationService.ensureIndexes();
  await Business.ensureIndexes();
  await User.ensureIndexes();
  await Otp.ensureIndexes();
  console.log('Indexes ensured');
};

const start = async () => {
  try {
    await db.connect();
    console.log('DB connected');

    // Bind the port immediately so Cloud Run sees the container as healthy,
    // then finish catalog seed + index migrations in the background.
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

    ensureAllIndexes().catch((err) => {
      console.error('Index setup failed (server still running):', err);
    });

    // Release expired payment holds so abandoned checkouts free up slots.
    const sweepMs = Number(process.env.BOOKING_SWEEP_INTERVAL_MS) || 60000;
    setInterval(() => {
      bookingService
        .releaseExpiredHolds()
        .catch((err) => console.error('hold sweep failed:', err.message));
      eventService
        .releaseExpiredHolds()
        .catch((err) => console.error('event hold sweep failed:', err.message));
    }, sweepMs).unref();
  } catch (err) {
    console.error('DB connection failed:', err);
    process.exit(1);
  }
};

start();

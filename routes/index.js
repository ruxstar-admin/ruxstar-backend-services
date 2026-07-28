const { Router } = require('express');
const authRoutes = require('./auth.routes');
const adminRoutes = require('./admin.routes');
const catalogRoutes = require('./catalog.routes');
const publicRoutes = require('./public.routes');
const userRoutes = require('./user.routes');
const vendorRoutes = require('./vendor.routes');
const webhookRoutes = require('./webhook.routes');
const notificationRoutes = require('./notification.routes');
const podRoutes = require('./pod.routes');
const commerceRoutes = require('./commerce.routes');

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'okay' }));
router.get('/', (_req, res) => res.json({ message: 'Welcome to Ruxstar Backend Services!' }));
router.use('/catalog', catalogRoutes);
router.use('/public', publicRoutes);
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/user', userRoutes);
router.use('/vendor', vendorRoutes);
router.use('/notifications', notificationRoutes);
router.use('/pod', podRoutes);
router.use('/commerce', commerceRoutes);
router.use('/creator', require('./creator.routes'));
router.use('/webhooks', webhookRoutes);

module.exports = router;

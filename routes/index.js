const { Router } = require('express');
const authRoutes = require('./auth.routes');
const adminRoutes = require('./admin.routes');
const catalogRoutes = require('./catalog.routes');
const publicRoutes = require('./public.routes');
const userRoutes = require('./user.routes');
const vendorRoutes = require('./vendor.routes');

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'okay' }));
router.get('/', (_req, res) => res.json({ message: 'Welcome to Ruxstar Backend Services!' }));
router.use('/catalog', catalogRoutes);
router.use('/public', publicRoutes);
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/user', userRoutes);
router.use('/vendor', vendorRoutes);

module.exports = router;

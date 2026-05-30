const { Router } = require('express');
const authRoutes = require('./auth.routes');

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'okay' }));
router.get('/', (_req, res) => res.json({ message: 'Welcome to Ruxstar Backend Services!' }));
router.use('/auth', authRoutes);

module.exports = router;

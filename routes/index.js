const { Router } = require('express');

const router = Router();

router.get('/health', async (req, res) => {
 res.json({ status: 'ok' });
});

router.get('/', async (req, res) => {
 res.json({ message: 'Welcome to Ruxstar Backend Services!' });
});


module.exports = router;

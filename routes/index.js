const { Router } = require('express');

const router = Router();

router.get('/', async (req, res) => {
  try {
    await req.app.locals.db.ping();
    res.json({ status: 'ok' });
  } catch {
    res.sendStatus(503);
  }
});

module.exports = router;

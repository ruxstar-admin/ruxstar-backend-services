const express = require('express');
const routes = require('./routes');
const notFound = require('./middlewares/notFound');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(routes);
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      message: 'selfie image too large; use JPEG and keep under 5MB',
    });
  }
  next(err);
});
app.use(notFound);

module.exports = app;

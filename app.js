const express = require('express');
const routes = require('./routes');
const notFound = require('./middlewares/notFound');

const app = express();

// Cloud Run terminates TLS and forwards via a proxy; trust it so client IPs
// (used by rate limiting) come from X-Forwarded-For rather than the proxy.
app.set('trust proxy', 1);

app.use(
  express.json({
    limit: '10mb',
    // Keep the exact bytes so webhook HMAC signatures verify correctly.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
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

const express = require('express');
const db = require('./lib/db');
const routes = require('./routes');

const port = Number(process.env.PORT) || 3000;

db.connect()
  .then(() => {
    const app = express();
    app.locals.db = db;
    app.use(routes);
    app.use((_req, res) => res.sendStatus(404));
    app.listen(port).on('error', (e) => {
      console.error(e.message);
      process.exit(1);
    });
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

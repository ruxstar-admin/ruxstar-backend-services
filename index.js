const express = require('express');
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const db = require('./lib/db');
const routes = require('./routes');

const app = express();
const port = process.env.PORT || 8080;

app.locals.db = db;

app.use(routes);
app.use((_req, res) => res.sendStatus(404));

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

db.connect()
  .then(() => console.log("DB connected"))
  .catch((err) => {
    console.error("DB connection failed:", err);
  });
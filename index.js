const express = require('express');
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

// connect DB AFTER server starts
db.connect()
  .then(() => console.log("DB connected"))
  .catch((err) => {
    console.error("DB connection failed:", err.message);
  });
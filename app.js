const express = require('express');
const routes = require('./routes');
const notFound = require('./middlewares/notFound');

const app = express();

app.use(express.json());
app.use(routes);
app.use(notFound);

module.exports = app;

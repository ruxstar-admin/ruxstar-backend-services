if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = require('./app');
const db = require('./config/database');

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

db.connect()
  .then(() => console.log('DB connected'))
  .catch((err) => {
    console.error('DB connection failed:', err);
  });

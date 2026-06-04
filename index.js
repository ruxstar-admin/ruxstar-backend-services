if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = require('./app');
const db = require('./config/database');

const port = process.env.PORT || 8080;

const start = async () => {
  try {
    await db.connect();
    console.log('DB connected');
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error('DB connection failed:', err);
    process.exit(1);
  }
};

start();

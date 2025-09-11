
const mongoose = require('mongoose');
const crypto = require('crypto');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error('MONGO_URI is not set. Refusing to start.');
      process.exit(1);
    }
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    const conn = mongoose.connection;
    const connectedDb = conn.name;
    console.log(`MongoDB connected: db='${connectedDb}'`);

    // Startup guard: ensure we are on the intended database/URI
    const expectedDb = process.env.EXPECTED_DB_NAME;
    if (expectedDb && connectedDb !== expectedDb) {
      console.error(`DB guard: connected db '${connectedDb}' does not match EXPECTED_DB_NAME='${expectedDb}'. Aborting.`);
      process.exit(1);
    }
    const expectedHash = process.env.EXPECTED_MONGO_URI_HASH;
    if (expectedHash) {
      const uriHash = crypto.createHash('sha256').update(mongoUri).digest('hex');
      if (uriHash !== expectedHash) {
        console.error('DB guard: MONGO_URI hash does not match EXPECTED_MONGO_URI_HASH. Aborting.');
        process.exit(1);
      }
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

module.exports = connectDB;

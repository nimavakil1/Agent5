/**
 * Database Connection Module
 *
 * Provides MongoDB connection management for the application.
 * Works alongside the Mongoose connection for models.
 */

const { MongoClient } = require('mongodb');

let client = null;
let db = null;

/**
 * Get the MongoDB database instance
 */
function getDb() {
  if (!db) {
    // Try to get from mongoose connection
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      return mongoose.connection.db;
    }
    throw new Error('Database not connected');
  }
  return db;
}

/**
 * Connect to MongoDB directly (for non-mongoose usage)
 */
async function connectDb(uri) {
  if (client) return db;

  const mongoUri = uri || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MongoDB URI not configured');
  }

  client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db();

  console.log('MongoDB direct client connected');
  return db;
}

/**
 * Close the MongoDB connection
 */
async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = {
  getDb,
  connectDb,
  closeDb,
};

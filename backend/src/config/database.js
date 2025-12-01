/**
 * Database Configuration
 *
 * MongoDB connection with proper pooling, timeouts, and health checks
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const pino = require('pino');

const logger = pino({ name: 'database' });

// Connection state
let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

/**
 * MongoDB connection options optimized for production
 */
const connectionOptions = {
  // Connection pool settings
  maxPoolSize: parseInt(process.env.MONGO_POOL_SIZE || '50', 10),
  minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE || '10', 10),
  maxIdleTimeMS: parseInt(process.env.MONGO_MAX_IDLE_MS || '45000', 10),

  // Timeouts
  serverSelectionTimeoutMS: parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT || '5000', 10),
  socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT || '45000', 10),
  connectTimeoutMS: parseInt(process.env.MONGO_CONNECT_TIMEOUT || '10000', 10),

  // Write concern for durability
  w: process.env.MONGO_WRITE_CONCERN || 'majority',
  wtimeoutMS: parseInt(process.env.MONGO_WTIMEOUT || '5000', 10),

  // Retry settings
  retryWrites: true,
  retryReads: true,

  // Use IPv4
  family: 4,

  // Heartbeat for connection health
  heartbeatFrequencyMS: parseInt(process.env.MONGO_HEARTBEAT_MS || '10000', 10),
};

/**
 * Connect to MongoDB with retry logic
 */
const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    logger.error('MONGO_URI is not set. Refusing to start.');
    process.exit(1);
  }

  while (connectionRetries < MAX_RETRIES) {
    try {
      logger.info({
        attempt: connectionRetries + 1,
        maxRetries: MAX_RETRIES,
        poolSize: connectionOptions.maxPoolSize,
      }, 'Connecting to MongoDB...');

      await mongoose.connect(mongoUri, connectionOptions);
      const conn = mongoose.connection;
      const connectedDb = conn.name;

      // Startup guard: ensure we are on the intended database/URI
      const expectedDb = process.env.EXPECTED_DB_NAME;
      if (expectedDb && connectedDb !== expectedDb) {
        logger.error({
          connected: connectedDb,
          expected: expectedDb,
        }, 'DB guard: connected db does not match EXPECTED_DB_NAME. Aborting.');
        process.exit(1);
      }

      const expectedHash = process.env.EXPECTED_MONGO_URI_HASH;
      if (expectedHash) {
        const uriHash = crypto.createHash('sha256').update(mongoUri).digest('hex');
        if (uriHash !== expectedHash) {
          logger.error('DB guard: MONGO_URI hash does not match EXPECTED_MONGO_URI_HASH. Aborting.');
          process.exit(1);
        }
      }

      isConnected = true;
      connectionRetries = 0;

      logger.info({
        database: connectedDb,
        poolSize: connectionOptions.maxPoolSize,
        host: conn.host,
      }, 'MongoDB connected successfully');

      // Setup connection event handlers
      setupConnectionHandlers(conn);

      return conn;
    } catch (error) {
      connectionRetries++;
      logger.error({
        error: error.message,
        attempt: connectionRetries,
        maxRetries: MAX_RETRIES,
      }, 'MongoDB connection error');

      if (connectionRetries >= MAX_RETRIES) {
        logger.fatal('Max connection retries exceeded. Exiting.');
        process.exit(1);
      }

      // Wait before retry with exponential backoff
      const delay = RETRY_DELAY_MS * Math.pow(2, connectionRetries - 1);
      logger.info({ delayMs: delay }, 'Retrying connection...');
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

/**
 * Setup connection event handlers for monitoring
 */
function setupConnectionHandlers(conn) {
  conn.on('error', (error) => {
    logger.error({ error: error.message }, 'MongoDB connection error');
    isConnected = false;
  });

  conn.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
    isConnected = false;
  });

  conn.on('reconnected', () => {
    logger.info('MongoDB reconnected');
    isConnected = true;
  });

  conn.on('close', () => {
    logger.warn('MongoDB connection closed');
    isConnected = false;
  });

  // Monitor slow queries in development
  if (process.env.NODE_ENV === 'development' || process.env.MONGO_DEBUG === '1') {
    mongoose.set('debug', (collectionName, methodName, ...methodArgs) => {
      logger.debug({
        collection: collectionName,
        method: methodName,
        args: methodArgs.length > 0 ? JSON.stringify(methodArgs[0]).slice(0, 200) : '',
      }, 'MongoDB query');
    });
  }
}

/**
 * Get connection health status
 */
function getHealthStatus() {
  const conn = mongoose.connection;

  return {
    status: isConnected ? 'healthy' : 'unhealthy',
    readyState: conn.readyState,
    readyStateLabel: ['disconnected', 'connected', 'connecting', 'disconnecting'][conn.readyState],
    database: conn.name || null,
    host: conn.host || null,
    poolSize: connectionOptions.maxPoolSize,
  };
}

/**
 * Gracefully close the connection
 */
async function closeConnection() {
  try {
    await mongoose.connection.close();
    isConnected = false;
    logger.info('MongoDB connection closed gracefully');
  } catch (error) {
    logger.error({ error: error.message }, 'Error closing MongoDB connection');
    throw error;
  }
}

/**
 * Check if connected
 */
function isDbConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

module.exports = connectDB;
module.exports.getHealthStatus = getHealthStatus;
module.exports.closeConnection = closeConnection;
module.exports.isConnected = isDbConnected;
module.exports.connectionOptions = connectionOptions;

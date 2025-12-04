/**
 * Session Registry
 *
 * In-memory registry of active PSTN/WebRTC sessions with:
 * - TTL-based automatic cleanup to prevent memory leaks
 * - Buffer size limits to prevent OOM
 * - Proper resource cleanup on removal
 * - Health monitoring and metrics
 */

const pino = require('pino');
const logger = pino({ name: 'session-registry' });

// Configuration
const CONFIG = {
  // Session TTL (default 2 hours - calls shouldn't last longer)
  SESSION_TTL_MS: parseInt(process.env.SESSION_TTL_MS || String(2 * 60 * 60 * 1000), 10),
  // Cleanup interval (check every minute)
  CLEANUP_INTERVAL_MS: parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS || '60000', 10),
  // Max sessions to prevent runaway growth
  MAX_SESSIONS: parseInt(process.env.MAX_SESSIONS || '1000', 10),
  // Max audio buffer size per session (10MB)
  MAX_BUFFER_SIZE: parseInt(process.env.MAX_AUDIO_BUFFER_SIZE || String(10 * 1024 * 1024), 10),
};

// Session storage
const sessions = new Map();

// Metrics
const metrics = {
  totalCreated: 0,
  totalRemoved: 0,
  totalExpired: 0,
  totalCleanupErrors: 0,
  peakSessions: 0,
};

// Cleanup timer
let cleanupTimer = null;

/**
 * Start the cleanup timer
 */
function startCleanup() {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let expiredCount = 0;

    for (const [room, session] of sessions.entries()) {
      // Check if session has expired
      if (session.expiresAt && now > session.expiresAt) {
        logger.warn({ room, age: now - session.createdAt }, 'Session expired, cleaning up');
        cleanupSession(room, 'expired');
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      metrics.totalExpired += expiredCount;
      logger.info({ expiredCount, activeSessions: sessions.size }, 'Cleanup completed');
    }
  }, CONFIG.CLEANUP_INTERVAL_MS);

  // Don't prevent process exit
  cleanupTimer.unref();
}

/**
 * Stop the cleanup timer
 */
function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Cleanup a session and its resources
 */
async function cleanupSession(room, reason = 'manual') {
  const session = sessions.get(room);
  if (!session) return false;

  logger.info({ room, reason }, 'Cleaning up session');

  try {
    // Close OpenAI WebSocket
    if (session.openaiWs) {
      try {
        if (session.openaiWs.readyState === 1) {
          session.openaiWs.close(1000, 'Session cleanup');
        }
      } catch (e) {
        logger.debug({ room, error: e.message }, 'Error closing OpenAI WebSocket');
      }
      session.openaiWs = null;
    }

    // Close Telnyx WebSocket
    if (session.telnyxWs) {
      try {
        if (session.telnyxWs.readyState === 1) {
          session.telnyxWs.close(1000, 'Session cleanup');
        }
      } catch (e) {
        logger.debug({ room, error: e.message }, 'Error closing Telnyx WebSocket');
      }
      session.telnyxWs = null;
    }

    // Close LiveKit publisher
    if (session.livekitPublisher) {
      try {
        if (typeof session.livekitPublisher.close === 'function') {
          await session.livekitPublisher.close();
        }
      } catch (e) {
        logger.debug({ room, error: e.message }, 'Error closing LiveKit publisher');
      }
      session.livekitPublisher = null;
    }

    // Clear audio buffers
    if (session.audioBuffer) {
      session.audioBuffer = null;
    }
    if (session.aiPcmuQueue) {
      session.aiPcmuQueue = null;
    }

    // Clear any timers
    if (session.aiSendTimer) {
      clearInterval(session.aiSendTimer);
      session.aiSendTimer = null;
    }
    if (session.ttsAbort) {
      try { session.ttsAbort.abort(); } catch (_) {}
      session.ttsAbort = null;
    }

    // Remove from registry
    sessions.delete(room);
    metrics.totalRemoved++;

    return true;
  } catch (error) {
    logger.error({ room, error: error.message }, 'Error during session cleanup');
    metrics.totalCleanupErrors++;

    // Force remove even if cleanup fails
    sessions.delete(room);
    return false;
  }
}

/**
 * Set/update session data
 */
function set(room, data) {
  if (!room) return null;

  const roomKey = String(room);
  const now = Date.now();

  // Check max sessions limit
  if (!sessions.has(roomKey) && sessions.size >= CONFIG.MAX_SESSIONS) {
    logger.error({ room, maxSessions: CONFIG.MAX_SESSIONS }, 'Max sessions limit reached');
    throw new Error('Max sessions limit reached');
  }

  const existing = sessions.get(roomKey) || {
    createdAt: now,
    expiresAt: now + CONFIG.SESSION_TTL_MS,
    bufferSize: 0,
  };

  const updated = {
    ...existing,
    ...data,
    updatedAt: now,
    // Extend TTL on activity
    expiresAt: now + CONFIG.SESSION_TTL_MS,
  };

  sessions.set(roomKey, updated);

  // Update metrics
  if (!existing.createdAt || existing.createdAt === now) {
    metrics.totalCreated++;
  }
  if (sessions.size > metrics.peakSessions) {
    metrics.peakSessions = sessions.size;
  }

  // Start cleanup if not running
  if (!cleanupTimer) {
    startCleanup();
  }

  return updated;
}

/**
 * Get session data
 */
function get(room) {
  if (!room) return null;
  return sessions.get(String(room)) || null;
}

/**
 * Remove session with cleanup
 */
async function remove(room) {
  if (!room) return false;
  return cleanupSession(String(room), 'manual');
}

/**
 * Stop AI for a session
 */
async function stopAI(room) {
  const session = get(room);
  if (!session) return false;

  try {
    session.aiStopped = true;

    if (session.openaiWs && session.openaiWs.readyState === 1) {
      try {
        session.openaiWs.close(1000, 'AI stopped');
      } catch (_) {}
    }

    if (session.livekitPublisher && typeof session.livekitPublisher.muteAgent === 'function') {
      try {
        session.livekitPublisher.muteAgent(true);
      } catch (_) {}
    }

    logger.info({ room }, 'AI stopped for session');
    return true;
  } catch (error) {
    logger.error({ room, error: error.message }, 'Error stopping AI');
    return false;
  }
}

/**
 * Send PCMU audio to PSTN with buffer limit checking
 */
function sendPcmuToPstn(room, pcmuFrame, streamId) {
  const session = get(room);
  if (!session || !session.telnyxWs) return false;

  try {
    // Check if WebSocket is open
    if (session.telnyxWs.readyState !== 1) {
      return false;
    }

    const payload = pcmuFrame.toString('base64');
    const msg = { event: 'media', media: { payload } };

    if (session.telnyxStreamId || streamId) {
      msg.stream_id = streamId || session.telnyxStreamId;
    }

    session.telnyxWs.send(JSON.stringify(msg));
    return true;
  } catch (error) {
    logger.debug({ room, error: error.message }, 'Error sending PCMU to PSTN');
    return false;
  }
}

/**
 * Set agent mute state
 */
function setAgentMute(room, mute) {
  const session = get(room);
  if (!session || !session.livekitPublisher) return false;

  try {
    session.livekitPublisher.muteAgent(!!mute);
    return true;
  } catch (error) {
    logger.debug({ room, error: error.message }, 'Error setting agent mute');
    return false;
  }
}

/**
 * Append to audio buffer with size limit
 */
function appendToBuffer(room, bufferName, data) {
  const session = get(room);
  if (!session) return false;

  const currentBuffer = session[bufferName] || Buffer.alloc(0);
  const newSize = currentBuffer.length + data.length;

  // Check buffer size limit
  if (newSize > CONFIG.MAX_BUFFER_SIZE) {
    logger.warn({
      room,
      bufferName,
      currentSize: currentBuffer.length,
      attemptedAdd: data.length,
      maxSize: CONFIG.MAX_BUFFER_SIZE,
    }, 'Buffer size limit exceeded, truncating');

    // Keep only the most recent data
    const keepSize = CONFIG.MAX_BUFFER_SIZE - data.length;
    session[bufferName] = Buffer.concat([
      currentBuffer.slice(-keepSize),
      data,
    ]);
  } else {
    session[bufferName] = Buffer.concat([currentBuffer, data]);
  }

  session.bufferSize = (session.bufferSize || 0) + data.length;
  return true;
}

/**
 * Clear a buffer
 */
function clearBuffer(room, bufferName) {
  const session = get(room);
  if (!session) return false;

  const freedSize = session[bufferName]?.length || 0;
  session[bufferName] = Buffer.alloc(0);
  session.bufferSize = Math.max(0, (session.bufferSize || 0) - freedSize);

  return true;
}

/**
 * Get all sessions (for diagnostics)
 */
function list() {
  const out = [];
  const now = Date.now();

  for (const [room, s] of sessions.entries()) {
    out.push({
      room,
      hasTelnyx: !!s.telnyxWs,
      hasOpenai: !!s.openaiWs,
      hasPublisher: !!s.livekitPublisher,
      telnyxStreamId: s.telnyxStreamId || null,
      aiStopped: !!s.aiStopped,
      createdAt: s.createdAt,
      ageMs: now - s.createdAt,
      expiresIn: s.expiresAt - now,
      bufferSize: s.bufferSize || 0,
    });
  }

  return out;
}

/**
 * Get metrics
 */
function getMetrics() {
  return {
    ...metrics,
    activeSessions: sessions.size,
    config: CONFIG,
  };
}

/**
 * Get health status
 */
function getHealth() {
  const activeSessions = sessions.size;

  return {
    status: activeSessions < CONFIG.MAX_SESSIONS * 0.9 ? 'healthy' : 'degraded',
    activeSessions,
    maxSessions: CONFIG.MAX_SESSIONS,
    utilizationPercent: ((activeSessions / CONFIG.MAX_SESSIONS) * 100).toFixed(1),
    cleanupRunning: !!cleanupTimer,
  };
}

/**
 * Shutdown - cleanup all sessions
 */
async function shutdown() {
  logger.info({ activeSessions: sessions.size }, 'Shutting down session registry');
  stopCleanup();

  const rooms = Array.from(sessions.keys());
  for (const room of rooms) {
    await cleanupSession(room, 'shutdown');
  }

  logger.info('Session registry shutdown complete');
}

// Start cleanup on module load
startCleanup();

module.exports = {
  set,
  get,
  remove,
  stopAI,
  sendPcmuToPstn,
  setAgentMute,
  appendToBuffer,
  clearBuffer,
  cleanupSession,
  list,
  getMetrics,
  getHealth,
  shutdown,
  startCleanup,
  stopCleanup,
  // Expose config for testing
  CONFIG,
  // Legacy export
  _list: list,
};

/**
 * Agent5 Platform Core
 *
 * Main entry point for the modular platform architecture.
 * The AI call center is just one module among many (messaging, analytics, etc.)
 */

// Platform foundation
const { Platform, createPlatform, getPlatform } = require('./Platform');

// Error handling
const errors = require('./errors');

// Resilience patterns
const resilience = require('./resilience');

// Voice pipeline
const voice = require('./voice');

// Observability
const observability = require('./observability');

// Platform modules
const modules = require('./modules');

module.exports = {
  // Platform
  Platform,
  createPlatform,
  getPlatform,

  // Errors
  ...errors,

  // Resilience
  ...resilience,

  // Voice
  voice,

  // Observability
  observability,

  // Modules
  modules,
};

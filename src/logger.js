const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// Per-request context (correlation id) travels through async calls automatically.
const als = new AsyncLocalStorage();

const logDir = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'handoffhub' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Never let secrets reach the log file, even if someone logs them by mistake.
    redact: {
      paths: ['apiKey', '*.apiKey', 'authorization', '*.authorization', 'headers.authorization', 'GEMINI_API_KEY', '*.GEMINI_API_KEY'],
      censor: '[REDACTED]',
    },
    // Adds reqId to EVERY log line written inside a request.
    mixin() {
      const store = als.getStore();
      return store ? { reqId: store.reqId } : {};
    },
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: path.join(logDir, 'app.log'), sync: true, mkdir: true }) },
  ])
);

module.exports = { logger, als };

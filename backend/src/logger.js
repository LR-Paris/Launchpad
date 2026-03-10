const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_LOG_FILES = 3;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFile = path.join(LOG_DIR, 'launchpad.log');

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size < MAX_LOG_SIZE) return;

    // Rotate: launchpad.log -> launchpad.1.log -> launchpad.2.log ...
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const older = path.join(LOG_DIR, `launchpad.${i}.log`);
      const newer = i === 1 ? logFile : path.join(LOG_DIR, `launchpad.${i - 1}.log`);
      if (fs.existsSync(newer)) {
        fs.renameSync(newer, older);
      }
    }
  } catch { /* best-effort rotation */ }
}

function timestamp() {
  return new Date().toISOString();
}

function appendToLog(level, args) {
  try {
    rotateIfNeeded();
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    fs.appendFileSync(logFile, `${timestamp()} [${level}] ${msg}\n`);
  } catch { /* never crash due to logging */ }
}

// Override console methods to also write to log file
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
  origLog(...args);
  appendToLog('INFO', args);
};

console.warn = (...args) => {
  origWarn(...args);
  appendToLog('WARN', args);
};

console.error = (...args) => {
  origError(...args);
  appendToLog('ERROR', args);
};

// Capture uncaught exceptions and unhandled rejections
process.on('uncaughtException', (err) => {
  appendToLog('FATAL', [`Uncaught Exception: ${err.stack || err.message}`]);
  origError('FATAL: Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  appendToLog('ERROR', [`Unhandled Rejection: ${msg}`]);
  origError('Unhandled Rejection:', reason);
});

appendToLog('INFO', ['--- Launchpad backend starting ---']);

module.exports = { logFile, LOG_DIR };

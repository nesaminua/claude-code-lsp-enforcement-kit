'use strict';

/**
 * logger.js — Debug logging for LSP Enforcement Kit
 *
 * Enable with: LSP_ENFORCE_DEBUG=1
 * Logs to: ~/.claude/logs/lsp-enforcement.log
 *
 * Log levels:
 *   - info: normal operations (tool intercepted, decision made)
 *   - detail: verbose (cache lookups, symbol detection, state reads)
 *   - block: enforcement actions (blocked calls with reasons)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const LOG_DIR = path.join(CLAUDE_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'lsp-enforcement.log');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB, then rotate

let _enabled = null;

function isEnabled() {
  if (_enabled === null) {
    // Check environment variable first
    if (process.env.LSP_ENFORCE_DEBUG === '1' || process.env.LSP_ENFORCE_DEBUG === 'true') {
      _enabled = true;
      return _enabled;
    }
    // Check settings.json
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        _enabled = settings.lspEnforcementDebug === true;
      } else {
        _enabled = false;
      }
    } catch {
      _enabled = false;
    }
  }
  return _enabled;
}

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch { /* silent */ }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = LOG_FILE + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch { /* file doesn't exist or can't rotate, that's fine */ }
}

function formatTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').replace('Z', '');
}

function write(level, hook, message, data = null) {
  if (!isEnabled()) return;

  ensureLogDir();
  rotateIfNeeded();

  const timestamp = formatTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(6)}] [${hook}]`;

  let line = `${prefix} ${message}`;
  if (data !== null) {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    // Indent multi-line data
    if (dataStr.includes('\n')) {
      line += '\n' + dataStr.split('\n').map(l => '  ' + l).join('\n');
    } else {
      line += ` | ${dataStr}`;
    }
  }
  line += '\n';

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* silent */ }
}

/**
 * Log an info message (normal operation)
 */
function info(hook, message, data = null) {
  write('info', hook, message, data);
}

/**
 * Log a detail message (verbose, for debugging)
 */
function detail(hook, message, data = null) {
  write('detail', hook, message, data);
}

/**
 * Log a block action (enforcement)
 */
function block(hook, message, data = null) {
  write('block', hook, message, data);
}

/**
 * Log a warn action
 */
function warn(hook, message, data = null) {
  write('warn', hook, message, data);
}

/**
 * Log an allow decision
 */
function allow(hook, message, data = null) {
  write('allow', hook, message, data);
}

/**
 * Log the start of hook execution with input data
 */
function start(hook, toolName, input) {
  if (!isEnabled()) return;
  info(hook, `Intercepted ${toolName}`, { input });
}

/**
 * Log the end of hook execution with decision
 */
function end(hook, decision, reason = null) {
  if (!isEnabled()) return;
  const level = decision === 'block' ? 'block' :
                decision === 'warn' ? 'warn' : 'allow';
  write(level, hook, `Decision: ${decision}`, reason ? { reason } : null);
}

module.exports = {
  isEnabled,
  info,
  detail,
  block,
  warn,
  allow,
  start,
  end,
  LOG_FILE,
};

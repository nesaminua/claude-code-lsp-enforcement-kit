#!/usr/bin/env node
'use strict';

// lsp-usage-tracker.js — PostToolUse hook (matcher: mcp__cclsp__*)
// Tracks successful LSP calls and manages warmup state.
// FAIL-OPEN: Any error silently exits without blocking.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');

function getFlagPath() {
  const cwd = process.cwd();
  const hash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  return path.join(STATE_DIR, `lsp-ready-${hash}`);
}

function readFlag(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Date.now() - (d.timestamp || 0) > 24 * 60 * 60 * 1000) return null;
    return d;
  } catch { return null; }
}

function isColdStartError(resp) {
  const s = typeof resp === 'string' ? resp : JSON.stringify(resp || {});
  return /No Project\.|ThrowNoProject|TypeScript Server Error|Server not initialized|Project not loaded|tsserver.*starting|LSP server.*not ready/i.test(s);
}

function isAnyError(resp) {
  if (!resp) return true;
  if (resp.is_error === true || resp.isError === true || resp.error) return true;
  if (Array.isArray(resp.content)) {
    for (const item of resp.content) {
      if (item && (item.is_error === true || item.isError === true)) return true;
      if (item && item.type === 'tool_result_error') return true;
    }
  }
  const s = typeof resp === 'string' ? resp : JSON.stringify(resp);
  if (/^Error[: ]|Error searching|Error finding|Error at /i.test(s)) return true;
  if (typeof resp === 'object' && !Array.isArray(resp) && Object.keys(resp).length === 0) return true;
  return false;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const toolName = data.tool_name || '';
    if (!toolName.startsWith('mcp__cclsp__')) process.exit(0);

    const resp = data.tool_response || data.result || {};

    if (isColdStartError(resp)) {
      const isSymbolSearch = toolName.includes('find_workspace_symbols');
      console.log(JSON.stringify({ systemMessage:
        `⚠️ cclsp "No Project" error (known upstream bug)\n\n` +
        `${isSymbolSearch ? 'find_workspace_symbols does NOT prime the project.\n' : ''}` +
        `Fix: call mcp__cclsp__get_diagnostics(<any .ts file>) first, then retry.\n` +
        `This is an ordering bug, not a timing issue. Do NOT fall back to Grep.`
      }));
      process.exit(0);
    }

    if (isAnyError(resp)) process.exit(0);

    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const flagPath = getFlagPath();
    const existing = readFlag(flagPath) || {
      cwd: process.cwd(), warmup_done: false, nav_count: 0, read_count: 0, read_files: [],
    };

    if (!existing.warmup_done) {
      existing.warmup_done = true;
      existing.cold_start_retries = 0;
    } else {
      existing.nav_count = (existing.nav_count || 0) + 1;
    }

    existing.timestamp = Date.now();
    existing.last_tool = toolName;
    fs.writeFileSync(flagPath, JSON.stringify(existing));
  } catch {
    // Fail open — tracker errors should never affect anything
  }
  process.exit(0);
});

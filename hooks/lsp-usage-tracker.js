#!/usr/bin/env node
'use strict';

/**
 * lsp-usage-tracker.js — PostToolUse hook
 *
 * Tracks successful LSP-provider calls in ~/.claude/state/lsp-ready-<hash>.
 * Sibling hook lsp-first-read-guard.js reads this state to make gate
 * decisions.
 *
 * Provider-aware: counts calls from any known LSP MCP server (cclsp,
 * Serena, ...) via ./lib/detect-lsp-provider.js — not hardcoded to cclsp.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { isLspProviderTool } = require('./lib/detect-lsp-provider');
const { isSkeletonPath } = require('./lib/read-cached-context');
const log = require('./lib/logger');

const HOOK = 'tracker';

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

// cclsp-specific upstream bug (ktnyt/cclsp#43). Serena has its own LSP
// wrapper and doesn't hit this class of error — skip the hint for non-cclsp.
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
    const isLspTool = isLspProviderTool(toolName);
    const filePath = String(data.tool_input?.file_path ?? '');
    const isSkeletonRead = toolName === 'Read' && isSkeletonPath(filePath);

    // Exit if not an LSP tool or skeleton read
    if (!isLspTool && !isSkeletonRead) process.exit(0);

    const resp = data.tool_response || data.result || {};

    // Handle skeleton reads (increment skeleton_reads, not nav_count)
    if (isSkeletonRead) {
      if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
      const flagPath = getFlagPath();
      const existing = readFlag(flagPath) || {
        cwd: process.cwd(), warmup_done: false, nav_count: 0, read_count: 0, read_files: [], skeleton_reads: 0,
      };
      existing.skeleton_reads = (existing.skeleton_reads || 0) + 1;
      existing.timestamp = Date.now();
      existing.last_tool = `Read(skeleton:${filePath})`;
      fs.writeFileSync(flagPath, JSON.stringify(existing));
      log.info(HOOK, `Skeleton read tracked: skeleton_reads=${existing.skeleton_reads}`, { file: filePath });
      process.exit(0);
    }

    // Cold-start hint only for cclsp (upstream bug)
    if (toolName.startsWith('mcp__cclsp__') && isColdStartError(resp)) {
      const isSymbolSearch = toolName.includes('find_workspace_symbols');
      console.log(JSON.stringify({ systemMessage:
        `⚠️ cclsp "No Project" error (known upstream bug ktnyt/cclsp#43)\n\n` +
        `${isSymbolSearch ? 'find_workspace_symbols does NOT prime the project context.\n' : ''}` +
        `Fix: call mcp__cclsp__get_diagnostics(<any .ts file>) first, then retry.\n` +
        `This is an ordering bug, not a timing issue. Do NOT fall back to Grep.`
      }));
      process.exit(0);
    }

    if (isAnyError(resp)) process.exit(0);

    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const flagPath = getFlagPath();
    const existing = readFlag(flagPath) || {
      cwd: process.cwd(), warmup_done: false, nav_count: 0, read_count: 0, read_files: [], skeleton_reads: 0,
    };

    if (!existing.warmup_done) {
      existing.warmup_done = true;
      existing.cold_start_retries = 0;
      log.info(HOOK, `Warmup completed via ${toolName}`);
    } else {
      existing.nav_count = (existing.nav_count || 0) + 1;
      log.info(HOOK, `LSP nav tracked: nav_count=${existing.nav_count}`, { tool: toolName });
    }

    existing.timestamp = Date.now();
    existing.last_tool = toolName;
    fs.writeFileSync(flagPath, JSON.stringify(existing));
  } catch {}
  process.exit(0);
});

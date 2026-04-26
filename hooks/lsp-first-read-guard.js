#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { buildWarmupInstructions, buildFileWarmupCall } = require('./lib/detect-lsp-provider');
const { isInsideProject } = require('./lib/project-scope');

/**
 * Build a copy-pasteable warmup call parametrized by the exact file the
 * agent is about to Read. This is project-agnostic: it uses the file path
 * from the hook input instead of guessing a symbol name from the filename,
 * so it works in any project regardless of export conventions.
 */
function buildConcreteCall(filePath) {
  const call = buildFileWarmupCall(filePath, '  ');
  if (!call) return '';
  return `\nCONCRETE CALL FOR THIS FILE (works in any project):\n${call}\n`;
}

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|vue|svelte|cpp|c|h|hpp)$/i;
const ALLOW_NON_CODE_EXT = /\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss|html|lock|ini|conf|cfg)$/i;
const ALLOW_CONFIG_PATTERNS = /(\.config\.|tsconfig|next\.config|vite\.config|webpack\.config|rollup\.config|babel\.config|jest\.config|vitest\.config|tailwind\.config|postcss\.config|eslint|prettier|package\.json|pnpm-lock|yarn\.lock)/i;
const ALLOW_PATH_PATTERNS = /(^|\/)(\.task|\.claude|\.git|node_modules|build|dist|out|public|scripts|docs?|knowledge-vault|supabase\/migrations|coverage|\.next|\.turbo|__tests__|__mocks__)(\/|$)/i;
const ALLOW_TEST_PATTERNS = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

const FLAG_EXPIRY_MS = 24 * 60 * 60 * 1000;
const FREE_READS = 2;
const WARN_AT = 3;
const REQUIRE_NAV_2_AT = 6;

function getFlagPath() {
  const cwd = process.cwd();
  const hash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  return path.join(STATE_DIR, `lsp-ready-${hash}`);
}

function ensureStateDir() {
  try { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

function readFlag(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Date.now() - (d.timestamp || 0) > FLAG_EXPIRY_MS) return null;
    return d;
  } catch { return null; }
}

function writeFlag(fp, flag) {
  try { ensureStateDir(); fs.writeFileSync(fp, JSON.stringify(flag)); } catch {}
}

function emitWarning(msg) { console.log(JSON.stringify({ systemMessage: msg })); }
function emitBlock(msg) { process.stderr.write(msg); process.exit(2); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (data.tool_name !== 'Read') process.exit(0);

  // String coercion: non-string input would throw on .trim() and fail-open.
  const filePath = String(data.tool_input?.file_path ?? '').trim();
  if (!filePath) process.exit(0);

  // Scope enforcement to the current project. Outside the project, Serena
  // cannot answer the same query (its index is project-scoped), so blocking
  // Read would leave the agent with no working alternative.
  if (!isInsideProject(filePath, data.cwd)) process.exit(0);

  if (ALLOW_NON_CODE_EXT.test(filePath)) process.exit(0);
  if (ALLOW_CONFIG_PATTERNS.test(path.basename(filePath))) process.exit(0);
  if (ALLOW_PATH_PATTERNS.test(filePath)) process.exit(0);
  if (ALLOW_TEST_PATTERNS.test(filePath)) process.exit(0);
  if (!CODE_EXTENSIONS.test(filePath)) process.exit(0);

  const flagPath = getFlagPath();
  const flag = readFlag(flagPath);

  if (!flag || !flag.warmup_done) {
    const warmupLines = buildWarmupInstructions('  ').join('\n');
    const concrete = buildConcreteCall(filePath);
    emitBlock(
      `⛔ LSP-FIRST BLOCK (Gate 1 — Warmup Required)\n\n` +
      `Read on code file requires prior LSP warmup.\n\n` +
      `WARMUP PROTOCOL — call one of these first:\n` +
      `${warmupLines}\n` +
      concrete +
      `\nAfter warmup: ${FREE_READS} free Reads, then need LSP navigation.\n\n` +
      `Blocked: ${filePath}\n`
    );
  }

  const readFiles = Array.isArray(flag.read_files) ? flag.read_files : [];
  const navCount = flag.nav_count || 0;
  const alreadyRead = readFiles.includes(filePath);
  const nextReadNum = alreadyRead ? readFiles.length : readFiles.length + 1;

  if (navCount >= 2 || alreadyRead) {
    if (!alreadyRead) {
      readFiles.push(filePath);
      flag.read_files = readFiles;
      flag.read_count = readFiles.length;
      flag.timestamp = Date.now();
      writeFlag(flagPath, flag);
    }
    process.exit(0);
  }

  if (nextReadNum <= FREE_READS) {
    readFiles.push(filePath);
    flag.read_files = readFiles;
    flag.read_count = readFiles.length;
    flag.timestamp = Date.now();
    writeFlag(flagPath, flag);
    process.exit(0);
  }

  if (nextReadNum === WARN_AT && navCount === 0) {
    emitWarning(
      `⚠️ LSP-FIRST WARNING (Read ${nextReadNum}) — consider LSP navigation.\n` +
      `Use find_workspace_symbols / find_references before more Reads.\n` +
      `Next Read will be BLOCKED unless you use at least 1 LSP nav call.\n` +
      `After 2 nav calls, all Reads are unlimited (surgical mode).`
    );
    readFiles.push(filePath);
    flag.read_files = readFiles;
    flag.read_count = readFiles.length;
    flag.timestamp = Date.now();
    writeFlag(flagPath, flag);
    process.exit(0);
  }

  if (nextReadNum < REQUIRE_NAV_2_AT && navCount < 1) {
    emitBlock(
      `⛔ LSP-FIRST BLOCK (Gate 4 — LSP Navigation Required)\n\n` +
      `Read #${nextReadNum} requires at least 1 LSP navigation call.\n` +
      `After 1 nav call, Reads 4-5 unlock. After 2, unlimited.\n` +
      buildConcreteCall(filePath) +
      `\nBlocked: ${filePath}\n`
    );
  }

  if (nextReadNum >= REQUIRE_NAV_2_AT && navCount < 2) {
    emitBlock(
      `⛔ LSP-FIRST BLOCK (Gate 5 — Surgical Mode Required)\n\n` +
      `Read #${nextReadNum} requires at least 2 LSP navigation calls.\n` +
      `Current: ${navCount} nav calls. Need 2.\n` +
      buildConcreteCall(filePath) +
      `\nBlocked: ${filePath}\n`
    );
  }

  readFiles.push(filePath);
  flag.read_files = readFiles;
  flag.read_count = readFiles.length;
  flag.timestamp = Date.now();
  writeFlag(flagPath, flag);
  process.exit(0);
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { buildWarmupInstructions } = require('./lib/detect-lsp-provider');
const { getSkeletonPath, getSkeletonRelativePath } = require('./lib/read-cached-context');
const log = require('./lib/logger');

const HOOK = 'read-guard';

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|vue|svelte|cpp|c|h|hpp)$/i;
const ALLOW_NON_CODE_EXT = /\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss|html|lock|ini|conf|cfg)$/i;
const ALLOW_CONFIG_PATTERNS = /(\.config\.|tsconfig|next\.config|vite\.config|webpack\.config|rollup\.config|babel\.config|jest\.config|vitest\.config|tailwind\.config|postcss\.config|eslint|prettier|package\.json|pnpm-lock|yarn\.lock)/i;
const ALLOW_PATH_PATTERNS = /(^|\/)(\.task|\.claude|\.git|node_modules|build|dist|out|public|scripts|docs?|knowledge-vault|supabase\/migrations|coverage|\.next|\.turbo|__tests__|__mocks__|_optivault|\.codesight)(\/|$)/i;
const ALLOW_TEST_PATTERNS = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

const FLAG_EXPIRY_MS = 24 * 60 * 60 * 1000;
const FREE_READS = 2;
const WARN_AT = 3;
const REQUIRE_NAV_1_AT = 4;
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

  log.start(HOOK, 'Read', { file: filePath });

  if (ALLOW_NON_CODE_EXT.test(filePath)) { log.end(HOOK, 'allow', 'non-code extension'); process.exit(0); }
  if (ALLOW_CONFIG_PATTERNS.test(path.basename(filePath))) { log.end(HOOK, 'allow', 'config file'); process.exit(0); }
  if (ALLOW_PATH_PATTERNS.test(filePath)) { log.end(HOOK, 'allow', 'allowed path pattern'); process.exit(0); }
  if (ALLOW_TEST_PATTERNS.test(filePath)) { log.end(HOOK, 'allow', 'test file'); process.exit(0); }
  if (!CODE_EXTENSIONS.test(filePath)) { log.end(HOOK, 'allow', 'non-code file'); process.exit(0); }

  const flagPath = getFlagPath();
  const flag = readFlag(flagPath);

  log.detail(HOOK, 'State', { warmup: flag?.warmup_done, nav: flag?.nav_count, skeleton: flag?.skeleton_reads, reads: flag?.read_count });

  if (!flag || !flag.warmup_done) {
    log.end(HOOK, 'block', 'Gate 1 - warmup required');
    const warmupLines = buildWarmupInstructions('  ').join('\n');
    emitBlock(
      `⛔ LSP-FIRST BLOCK (Gate 1 — Warmup Required)\n\n` +
      `Read on code file requires prior LSP warmup.\n\n` +
      `WARMUP PROTOCOL — call one of these first:\n` +
      `${warmupLines}\n\n` +
      `After warmup: ${FREE_READS} free Reads, then need LSP navigation.\n\n` +
      `Blocked: ${filePath}\n`
    );
  }

  const readFiles = Array.isArray(flag.read_files) ? flag.read_files : [];
  const navCount = flag.nav_count || 0;
  const skeletonReads = flag.skeleton_reads || 0;
  // Skeleton reads count toward gate progression: 2 skeleton reads = 1 nav credit
  const effectiveNav = navCount + Math.floor(skeletonReads / 2);
  const alreadyRead = readFiles.includes(filePath);
  const nextReadNum = alreadyRead ? readFiles.length : readFiles.length + 1;

  // Check if skeleton exists for this file (for suggestions in block messages)
  const cwd = process.cwd();
  const skeletonPath = getSkeletonPath(cwd, filePath);
  const skeletonRelPath = skeletonPath ? getSkeletonRelativePath(filePath) : null;

  if (effectiveNav >= 2 || alreadyRead) {
    log.end(HOOK, 'allow', alreadyRead ? 'already read' : 'surgical mode (effectiveNav >= 2)');
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
    log.end(HOOK, 'allow', `Gate 2 - free read ${nextReadNum}/${FREE_READS}`);
    readFiles.push(filePath);
    flag.read_files = readFiles;
    flag.read_count = readFiles.length;
    flag.timestamp = Date.now();
    writeFlag(flagPath, flag);
    process.exit(0);
  }

  // Build skeleton suggestion if available
  const skeletonHint = skeletonRelPath
    ? `\n💡 SKELETON AVAILABLE: Read \`${skeletonRelPath}\` first (~50 tokens)\n` +
      `   Skeleton reads count toward gate progression (2 skeleton reads = 1 nav credit).\n`
    : '';

  if (nextReadNum === WARN_AT && effectiveNav === 0) {
    log.end(HOOK, 'warn', 'Gate 3 - warning issued');
    emitWarning(
      `⚠️ LSP-FIRST WARNING (Read ${nextReadNum}) — consider LSP navigation.\n` +
      `Use find_workspace_symbols / find_references before more Reads.\n` +
      `Next Read will be BLOCKED unless you use at least 1 LSP nav call.${skeletonHint}\n` +
      `After 2 nav calls (or equivalent skeleton reads), all Reads are unlimited (surgical mode).`
    );
    readFiles.push(filePath);
    flag.read_files = readFiles;
    flag.read_count = readFiles.length;
    flag.timestamp = Date.now();
    writeFlag(flagPath, flag);
    process.exit(0);
  }

  if (nextReadNum < REQUIRE_NAV_2_AT && effectiveNav < 1) {
    log.end(HOOK, 'block', `Gate 4 - need 1 nav (have ${effectiveNav})`);
    emitBlock(
      `⛔ LSP-FIRST BLOCK (Gate 4 — LSP Navigation Required)\n\n` +
      `Read #${nextReadNum} requires at least 1 LSP navigation call.\n` +
      `After 1 nav call, Reads 4-5 unlock. After 2, unlimited.${skeletonHint}\n` +
      `Blocked: ${filePath}\n`
    );
  }

  if (nextReadNum >= REQUIRE_NAV_2_AT && effectiveNav < 2) {
    log.end(HOOK, 'block', `Gate 5 - need 2 nav (have ${effectiveNav})`);
    emitBlock(
      `⛔ LSP-FIRST BLOCK (Gate 5 — Surgical Mode Required)\n\n` +
      `Read #${nextReadNum} requires at least 2 LSP navigation calls.\n` +
      `Current: ${navCount} nav calls + ${skeletonReads} skeleton reads = ${effectiveNav} effective nav.\n` +
      `Need 2 effective nav (LSP calls or 2 skeleton reads each).${skeletonHint}\n` +
      `Blocked: ${filePath}\n`
    );
  }

  readFiles.push(filePath);
  flag.read_files = readFiles;
  flag.read_count = readFiles.length;
  flag.timestamp = Date.now();
  writeFlag(flagPath, flag);
  process.exit(0);
});

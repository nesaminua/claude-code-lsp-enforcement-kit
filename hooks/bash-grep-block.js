#!/usr/bin/env node
'use strict';

// bash-grep-block.js — PreToolUse hook (matcher: Bash)
// Blocks grep/rg/ag/ack with code symbols in shell commands.
// Suggests LSP equivalent for the active provider (cclsp / Serena / ...).
// Allows: git grep, non-code paths, non-code file types.

const fs = require('fs');
const path = require('path');
const { buildSuggestion, buildStructuredBlockResponse } = require('./lib/detect-lsp-provider');
const { parseCommand } = require('./lib/grep-command');
const { isNonCodeTarget } = require('./lib/code-files');

// Zero-width / formatting chars that would split tokens invisibly and
// bypass ASCII regex symbol detection.
const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (data.tool_name !== 'Bash') process.exit(0);

  // String coercion: non-string command would throw on .trim() and fail-open.
  // Zero-width strip: prevents `grep\u200BUserFunc` evasion.
  const cmd = String(data.tool_input?.command ?? '').trim().replace(ZERO_WIDTH, '');
  // Fast path, case-insensitive to catch `GREP`, `RG` variants (and egrep).
  if (!/grep|\b(?:rg|ag|ack)\b/i.test(cmd)) process.exit(0);
  if (/--include=?\S*\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log)\b/i.test(cmd)) process.exit(0);

  // Each grep/rg/ag/ack invocation is parsed with its tool's own option table
  // (lib/grep-command.js) and judged on its own. Regexes over the whole
  // command missed `grep -rn getUserById src/` (a bare pattern after a flag),
  // read `--include '*.ts'` as the pattern, checked only the first pattern
  // found, and let `git grep` or a node_modules path anywhere in the command
  // excuse every grep in it.
  const { invocations, unaccounted } = parseCommand(cmd);
  const patterns = [];
  for (const inv of invocations) {
    if (inv.noSearch) continue;
    if (inv.conservative) {
      // Options it could not read: any word may be the pattern.
      patterns.push(...inv.words.map(w => w.text));
      continue;
    }
    // -l, -c, -q and friends print file names, counts or nothing, never
    // matched lines: there is no output for LSP to shrink, and "which files
    // mention X" has no LSP call.
    if (inv.listing) continue;
    if (searchesOnlyExemptPaths(inv)) continue;
    // Every target a non-code file (LaTeX, BibTeX, CSV, ...): no LSP indexes
    // those, so the suggested LSP call cannot answer.
    if (searchesOnlyNonCode(inv, data.cwd)) continue;
    patterns.push(...inv.patterns);
  }
  // A grep mention no parsed invocation accounts for (inside `ssh host "..."`,
  // an unknown wrapper, text that would not tokenize) gets the check every
  // grep got before, at that spot: the parse never excuses what it did not read.
  for (const index of unaccounted) {
    const pattern = legacyPatternAt(cmd, index);
    if (pattern) patterns.push(pattern);
  }

  if (patterns.length === 0) process.exit(0);

  const symbols = [...new Set(patterns.flatMap(extractSymbols))];

  // SECURITY: only allow the safe-prefix pipe bypass AFTER confirming no code symbols.
  // Previously `echo x | grep SomeCamelFunc` passed because the bypass ran before
  // symbol detection. Now: if symbols present, no bypass — always proceed to block.
  if (symbols.length === 0) {
    const targetsCodeEarly =
      /\bsrc[\\/]|\bapp[\\/]|components[\\/]|lib[\\/]|hooks[\\/]|utils[\\/]|services[\\/]|actions[\\/]/i.test(cmd) ||
      /\.tsx?\b|\.jsx?\b/i.test(cmd);
    const hasNonCodeTargetEarly = /\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log|toml|xml)\b/i.test(cmd) && !targetsCodeEarly;
    if (hasNonCodeTargetEarly) process.exit(0);

    const isSimplePipe = /\|/.test(cmd) && !/xargs|exec/.test(cmd);
    const grepPos = cmd.search(/\b(grep|rg|ag|ack)\b/i);
    const pipePos = cmd.indexOf('|');
    if (isSimplePipe && pipePos !== -1 && pipePos < grepPos) {
      const beforePipe = cmd.substring(0, pipePos).trim();
      if (/^(git|npm|npx|pnpm|node|echo|cat\s+\S+\.(?:json|md|txt|log|ya?ml))/i.test(beforePipe) ||
          /^(ls|wc|head|tail|sort|uniq)\b/i.test(beforePipe)) {
        process.exit(0);
      }
    }
    process.exit(0);
  }

  const targetsCode =
    /\bsrc[\\/]|\bapp[\\/]|components[\\/]|lib[\\/]|hooks[\\/]|utils[\\/]|services[\\/]|actions[\\/]/i.test(cmd) ||
    /\.tsx?\b|\.jsx?\b/i.test(cmd) ||
    /-t\s+(ts|tsx|js|jsx|typescript|javascript)\b/i.test(cmd) ||
    /--type[= ](ts|tsx|js|jsx|typescript)\b/i.test(cmd) ||
    /\bfind\b.*\b(src|app|components|lib)\b/.test(cmd) ||
    /\bxargs\b.*\b(grep|rg|ag|ack)\b/i.test(cmd) ||
    /-exec\s+(grep|rg|ag|ack)\b/i.test(cmd);

  const hasNonCodeTarget =
    /\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log|toml|xml)\b/i.test(cmd) &&
    !targetsCode;

  // Symbols are present — only bypass if the command is unambiguously
  // targeting non-code files AND doesn't touch code paths.
  if (hasNonCodeTarget && !targetsCode) process.exit(0);

  // Listing is allowed (see above), so say so: without this line the block
  // leaves no way to ask "which files mention X".
  const listingHint = 'Only need the files that mention it? grep -l lists them and is not blocked.';

  const suggestions = symbols.map(sym => {
    const intent = /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  process.stderr.write(
    `\n⛔ LSP-FIRST: Blocked grep/rg — found ${symbols.length} code symbol(s): ${symbols.join(', ')}\n` +
    `LSP is always connected. Use:\n${suggestions}\n${listingHint}\n\n`
  );

  const intent = /^[A-Z]/.test(symbols[0]) ? 'symbol_search' : 'references';
  console.log(JSON.stringify(buildStructuredBlockResponse({
    hook: 'bash-grep-block',
    symbols,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbols [${symbols.join(', ')}]. Use LSP:\n${suggestions}\n${listingHint}`,
  })));
});

// Paths that are not project source: dependencies, tool state, migrations.
const EXEMPT_PATH = /(?:^|[\/\\])(?:supabase[\/\\]migrations|\.task|\.claude|node_modules|knowledge-vault)(?:[\/\\]|$)/i;

// True when the invocation names its targets and every one is an exempt path.
function searchesOnlyExemptPaths(inv) {
  return !inv.extraOperands &&
    inv.operands.length > 0 &&
    inv.operands.every(w => !w.dynamic && EXEMPT_PATH.test(path.posix.normalize(w.text.replace(/\\/g, '/'))));
}

// True only on positive evidence that the invocation reads no code: every
// operand is a non-code file, or every --include/-g filter is non-code and
// it applies to every operand. grep applies --include to the files it is
// given; rg applies -g only inside directories it walks, so for rg every
// operand must be a directory. No operands means stdin or the whole tree,
// so that never counts. An operand that exists as a directory is never a
// non-code file, whatever its name ends in (vendor/golang.org).
function searchesOnlyNonCode(inv, cwd) {
  const ops = inv.operands;
  if (inv.extraOperands || ops.length === 0 || ops.some(w => w.dynamic || w.text === '-')) return false;
  if (ops.every(w => isNonCodeTarget(w.text) && !isDirectory(w.text, cwd))) return true;
  if (inv.includes.length === 0 || !inv.includes.every(g => g !== null && isNonCodeTarget(g))) return false;
  if (inv.tool === 'grep') return true;
  return ops.every(w => /^\.\.?$|[\\/]$/.test(w.text));
}

function isDirectory(p, cwd) {
  try {
    return fs.statSync(path.resolve(String(cwd || process.cwd()), p)).isDirectory();
  } catch {
    return false;
  }
}

const LEGACY_WINDOW = 4096;

// The pre-parser check, applied at one mention: the pattern the old regexes
// read for the grep that starts at cmd[index].
function legacyPatternAt(cmd, index) {
  // A bounded window keeps many mentions linear; a grep's flags and pattern
  // fit in far less.
  const text = cmd.slice(index, index + LEGACY_WINDOW).replace(/\\"/g, '"');
  const tool = '(?:[efg]?grep|rg|ag|ack(?:-grep)?)';
  const m =
    text.match(new RegExp(`^${tool}\\s+(?:-\\S+\\s+)*"([^"]+)"`, 'i')) ||
    text.match(new RegExp(`^${tool}\\s+(?:-\\S+\\s+)*'([^']+)'`, 'i')) ||
    text.match(new RegExp(`^${tool}\\s+(?:(?:-\\w+\\s+(?:[a-z]+\\s+)?)*?)([A-Z][a-zA-Z]\\w+)`, 'i'));
  return m ? m[1] : null;
}

function extractSymbols(fullPattern) {
  // Strip zero-width chars from the matched pattern (already stripped from cmd,
  // but an explicit safety for pattern extraction edge cases).
  // NOTE: split on BOTH `|` and `.` — previously we stripped dots, which merged
  // dotted expressions like `mcp.Tool` into `mcpTool` (camelCase false positive).
  // Now we split on dots so each side is evaluated independently.
  const parts = fullPattern
    .split(/\\?\||\./)
    .map(p => p.replace(ZERO_WIDTH, '').replace(/[*+?^${}()[\]\\]/g, '').trim())
    .filter(Boolean);
  return parts.filter(p => {
    if (p.length < 4 || /\s/.test(p)) return false;
    const skip = [
      /^(TODO|FIXME|HACK|XXX|NOTE)/i,
      /^console\b/, /^import\b/, /^export\b/, /^http/i, /^\d/,
      /^[A-Z_]{3,}$/, /^[a-z]{1,8}$/, /^[a-z]+-[a-z]+/,
    ];
    if (skip.some(rx => rx.test(p))) return false;

    // NOTE: dotted-symbol regex removed — after splitting on `.` above,
    // no `p` can contain a dot, so the path was dead code.
    return (/^[a-z][a-zA-Z0-9]{3,}$/.test(p) && /[A-Z]/.test(p)) ||
           /^[A-Z][a-zA-Z][a-zA-Z0-9]{2,}$/.test(p) ||
           (/^[a-z]+(_[a-z]+){2,}$/.test(p) && p.length >= 9);
  });
}

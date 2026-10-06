#!/usr/bin/env node
'use strict';

// lsp-first-guard.js — PreToolUse hook (matcher: Grep)
// Blocks Grep on code symbols. Suggests LSP equivalent for the active provider.

const fs = require('fs');
const path = require('path');
const { buildSuggestion, buildStructuredBlockResponse } = require('./lib/detect-lsp-provider');
const { isNonCodeTarget, isNonCodeType } = require('./lib/code-files');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch (e) { process.exit(0); }

  if (data.tool_name !== 'Grep') process.exit(0);

  const params  = data.tool_input || {};
  // String coercion: non-string pattern (number, array, etc.) would throw on .trim()
  // and fail-open — Claude Code treats crash as passthrough. See security review.
  const pattern = String(params.pattern ?? '').trim();
  const searchPath = String(params.path ?? '');
  const glob    = String(params.glob ?? '');

  // files_with_matches (the Grep tool's default) and count return paths or
  // numbers, never matched lines, so there is no output for LSP to shrink,
  // and "which files mention X" has no LSP call. Unknown modes stay guarded.
  const outputMode = String(params.output_mode ?? 'files_with_matches');
  if (outputMode === 'files_with_matches' || outputMode === 'count') process.exit(0);

  if (/knowledge-vault|\.task[\\/]|\.claude[\\/]|node_modules|logs?[\\/]|docs?[\\/]|supabase[\\/]migrations/i.test(searchPath)) {
    process.exit(0);
  }

  if (/\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss)/i.test(glob)) {
    process.exit(0);
  }

  // A search confined to non-code files: no LSP indexes them, so the
  // suggested call cannot answer it.
  if (searchesOnlyNonCode(searchPath, glob, params.type, data.cwd)) process.exit(0);

  if (pattern.length < 4) process.exit(0);

  const parts = pattern.split('|').map(p => p.trim()).filter(Boolean);
  const symbolParts = [];
  for (const part of parts) {
    if (isCodeSymbol(part)) symbolParts.push(part);
  }

  if (symbolParts.length === 0) process.exit(0);

  // files_with_matches is allowed (see above), so say so: without this line
  // the block leaves no way to ask "which files mention X".
  const listingHint = 'Only need the files that mention it? output_mode "files_with_matches" (the default) lists them and is not blocked.';

  const suggestions = symbolParts.map(sym => {
    const intent = /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  process.stderr.write(
    `\n⛔ LSP-FIRST BLOCK: ${symbolParts.length} code symbol(s) in Grep — use LSP instead\n` +
    `Symbols: ${symbolParts.join(', ')}\nLSP tools:\n${suggestions}\n${listingHint}\n\n`
  );

  // Emit structured JSON for programmatic consumers (monitoring, dashboards, IDE plugins).
  // `decision` and `reason` fields remain backward compatible.
  const intent = /^[A-Z]/.test(symbolParts[0]) ? 'symbol_search' : 'references';
  console.log(JSON.stringify(buildStructuredBlockResponse({
    hook: 'lsp-first-guard',
    symbols: symbolParts,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbol(s) [${symbolParts.join(', ')}]. Use LSP tools:\n${suggestions}\n${listingHint}`,
  })));
});

// The Grep tool runs rg. rg searches a file named as the path whatever the
// glob or type say, so a non-code glob or type only confines the search when
// the path is a directory (or absent: the working directory). Every filter
// given must be non-code. Anything unknown counts as code.
function searchesOnlyNonCode(searchPath, glob, type, cwd) {
  if (searchPath && !isDirectory(searchPath, cwd)) return isNonCodeTarget(searchPath);
  const filters = [];
  if (glob) filters.push(isNonCodeTarget(glob));
  if (type !== undefined && type !== null && type !== '') filters.push(isNonCodeType(type));
  return filters.length > 0 && filters.every(Boolean);
}

function isDirectory(p, cwd) {
  try {
    return fs.statSync(path.resolve(String(cwd || process.cwd()), p)).isDirectory();
  } catch {
    return false;
  }
}

function isCodeSymbol(s) {
  if (s.length < 4) return false;
  if (/\s/.test(s)) return false;
  if (/[&?+[\]{}()\\^$*]/.test(s)) return false;

  const allowList = [
    /^(TODO|FIXME|HACK|XXX|NOTE)/i,
    /^console\./, /^import\b/, /^require\(/, /^from\b/, /^export\b/,
    /^\/\//, /^#/, /^\./, /^http/i, /^\d/,
    /^[A-Z_]{3,}$/,
    /^[a-z]{1,8}$/,
    /^['"`]/,
    /^use (client|server)/,
  ];
  if (allowList.some(rx => rx.test(s))) return false;

  if (/^[a-z]+-[a-z]/.test(s)) {
    if (/^(text-|bg-|border-|font-|hover:|focus:|active:|group-|ring-|shadow-|rounded-|flex-|grid-|gap-|space-|divide-|overflow-|whitespace-|break-|leading-|tracking-|align-|justify-|items-|self-|order-|col-|row-|transition-|duration-|ease-|animate-|scale-|rotate-|translate-|origin-|cursor-|select-|resize-|appearance-|outline-|decoration-|underline-|line-|placeholder-|caret-|accent-|sr-|z-|opacity-|w-|h-|p-|m-|px-|py-|pt-|pb-|pl-|pr-|mx-|my-|mt-|mb-|ml-|mr-|max-|min-|inset-|top-|right-|bottom-|left-|float-|data-)/.test(s)) {
      return false;
    }
    if (/-(modal|form|dialog|sidebar|popover|tab|list|card|button|widget|table|page|layout|header|footer|section|panel|gallery|grid|menu|nav|banner|badge|skeleton|spinner|tooltip|dropdown|select|input|textarea|checkbox|radio|switch|slider|avatar|icon|chip|toast|alert|bar|row|cell|item|field|wrapper|container|provider|context|hook|view|screen|chart|editor|builder|filler|picker|uploader|timeline|breadcrumb|steward|runner|tester|checker|resolver|reviewer|optimizer|detector|guard|enforcer)s?$/.test(s)) {
      return true;
    }
    if (/^(actions?|helpers?|utils?|hooks?|types?|constants?|validations?|services?)-/.test(s)) {
      return true;
    }
    return false;
  }

  const isCamelCase = /^[a-z][a-zA-Z0-9]{3,}$/.test(s) && /[A-Z]/.test(s);
  const isPascalCase = /^[A-Z][a-zA-Z][a-zA-Z0-9]{2,}$/.test(s);
  const isDottedSymbol = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/i.test(s);
  const isSnakeCaseFunc = /^[a-z]+(_[a-z]+){2,}$/.test(s) && s.length >= 9;

  return isCamelCase || isPascalCase || isDottedSymbol || isSnakeCaseFunc;
}

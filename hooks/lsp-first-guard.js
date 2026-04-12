#!/usr/bin/env node
'use strict';

// lsp-first-guard.js — PreToolUse hook (matcher: Grep)
// Blocks Grep on code symbols. Suggests LSP equivalent for the active provider.

const { buildSuggestion, buildStructuredBlockResponse } = require('./lib/detect-lsp-provider');
const { lookupSymbolInCaches, formatCacheHits } = require('./lib/read-cached-context');
const log = require('./lib/logger');

const HOOK = 'grep-guard';

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

  log.start(HOOK, 'Grep', { pattern, path: searchPath, glob });

  if (/knowledge-vault|\.task[\\/]|\.claude[\\/]|node_modules|logs?[\\/]|docs?[\\/]|supabase[\\/]migrations/i.test(searchPath)) {
    log.end(HOOK, 'allow', 'non-code path');
    process.exit(0);
  }

  if (/\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss)/i.test(glob)) {
    log.end(HOOK, 'allow', 'non-code file glob');
    process.exit(0);
  }

  if (pattern.length < 4) {
    log.end(HOOK, 'allow', 'pattern too short');
    process.exit(0);
  }

  const parts = pattern.split('|').map(p => p.trim()).filter(Boolean);
  const symbolParts = [];
  for (const part of parts) {
    if (isCodeSymbol(part)) symbolParts.push(part);
  }

  if (symbolParts.length === 0) {
    log.end(HOOK, 'allow', 'no code symbols detected');
    process.exit(0);
  }

  log.detail(HOOK, 'Detected code symbols', symbolParts);

  // Check cache layers for symbol information
  const cwd = process.cwd();
  const cacheResults = symbolParts.map(sym => ({
    symbol: sym,
    ...lookupSymbolInCaches(cwd, sym),
  }));

  const cacheHitCount = cacheResults.filter(r => r.hasHits).length;
  if (cacheHitCount > 0) {
    log.detail(HOOK, `Cache hits: ${cacheHitCount}/${symbolParts.length} symbols`, cacheResults.filter(r => r.hasHits));
  }

  // Build cache hit section if any symbols found in cache
  const cacheHitLines = [];
  for (const result of cacheResults) {
    const hitMsg = formatCacheHits(result.symbol, result.repoMap, result.routes, result.schema);
    if (hitMsg) cacheHitLines.push(hitMsg);
  }
  const cacheSection = cacheHitLines.length > 0
    ? `\n📦 CACHED CONTEXT:\n${cacheHitLines.join('\n')}\n  (For references/callers, use LSP below)\n`
    : '';

  const suggestions = symbolParts.map(sym => {
    const intent = /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  log.end(HOOK, 'block', `${symbolParts.length} code symbol(s): ${symbolParts.join(', ')}`);

  process.stderr.write(
    `\n⛔ LSP-FIRST BLOCK: ${symbolParts.length} code symbol(s) in Grep — use LSP instead\n` +
    `Symbols: ${symbolParts.join(', ')}${cacheSection}\nLSP tools:\n${suggestions}\n\n`
  );

  // Emit structured JSON for programmatic consumers (monitoring, dashboards, IDE plugins).
  // `decision` and `reason` fields remain backward compatible.
  const intent = /^[A-Z]/.test(symbolParts[0]) ? 'symbol_search' : 'references';
  const structuredResponse = buildStructuredBlockResponse({
    hook: 'lsp-first-guard',
    symbols: symbolParts,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbol(s) [${symbolParts.join(', ')}].${cacheSection ? ' Cache hits available.' : ''} Use LSP tools:\n${suggestions}`,
  });
  // Add cache hits to structured response
  structuredResponse.cacheHits = cacheResults.filter(r => r.hasHits).map(r => ({
    symbol: r.symbol,
    repoMap: r.repoMap,
    routes: r.routes,
    schema: r.schema,
  }));
  console.log(JSON.stringify(structuredResponse));
});

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

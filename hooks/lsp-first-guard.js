#!/usr/bin/env node
'use strict';

// lsp-first-guard.js — PreToolUse hook (matcher: Grep)
// Blocks Grep on code symbols. Suggests LSP equivalent for the active provider.

const { buildSuggestion, buildStructuredBlockResponse } = require('./lib/detect-lsp-provider');
const { isInsideProject } = require('./lib/project-scope');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch (e) { process.exit(0); }

  if (data.tool_name !== 'Grep') process.exit(0);

  // Scope enforcement to the current project. Outside the project, Serena
  // cannot answer the same query (its index is project-scoped), so blocking
  // Grep would leave the agent with no working alternative.
  if (!isInsideProject(data.tool_input?.path, data.cwd)) process.exit(0);

  const params  = data.tool_input || {};
  // String coercion: non-string pattern (number, array, etc.) would throw on .trim()
  // and fail-open — Claude Code treats crash as passthrough. See security review.
  const pattern = String(params.pattern ?? '').trim();
  const searchPath = String(params.path ?? '');
  const glob    = String(params.glob ?? '');

  if (/knowledge-vault|\.task[\\/]|\.claude[\\/]|node_modules|logs?[\\/]|docs?[\\/]|supabase[\\/]migrations/i.test(searchPath)) {
    process.exit(0);
  }

  if (/\.(md|txt|log|json|jsonc|yaml|yml|env|csv|toml|xml|sql|sh|css|scss)/i.test(glob)) {
    process.exit(0);
  }

  if (pattern.length < 4) process.exit(0);

  const parts = pattern.split('|').map(p => p.trim()).filter(Boolean);
  const symbolParts = [];
  for (const part of parts) {
    if (isCodeSymbol(part)) symbolParts.push(part);
  }

  if (symbolParts.length === 0) process.exit(0);

  const suggestions = symbolParts.map(sym => {
    const intent = /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  process.stderr.write(
    `\n⛔ LSP-FIRST BLOCK: ${symbolParts.length} code symbol(s) in Grep — use LSP instead\n` +
    `Symbols: ${symbolParts.join(', ')}\nLSP tools:\n${suggestions}\n\n`
  );

  // Emit structured JSON for programmatic consumers (monitoring, dashboards, IDE plugins).
  // `decision` and `reason` fields remain backward compatible.
  const intent = /^[A-Z]/.test(symbolParts[0]) ? 'symbol_search' : 'references';
  console.log(JSON.stringify(buildStructuredBlockResponse({
    hook: 'lsp-first-guard',
    symbols: symbolParts,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbol(s) [${symbolParts.join(', ')}]. Use LSP tools:\n${suggestions}`,
  })));
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

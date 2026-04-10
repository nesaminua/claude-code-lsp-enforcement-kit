#!/usr/bin/env node
'use strict';

// lsp-first-guard.js — PreToolUse hook (matcher: Grep)
// Blocks Grep on code symbols when LSP is available. Suggests LSP equivalent.
// FAIL-OPEN: If cclsp/LSP is not available, allows Grep through.

const fs = require('fs');
const path = require('path');

function isLspProject() {
  const cwd = process.cwd();
  const indicators = [
    'tsconfig.json', 'jsconfig.json', 'tsconfig.base.json',
    'tsconfig.app.json', 'tsconfig.node.json',
  ];
  return indicators.some(f => {
    try { return fs.existsSync(path.join(cwd, f)); } catch { return false; }
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    let data;
    try { data = JSON.parse(raw); } catch (e) { process.exit(0); }

    if (data.tool_name !== 'Grep') process.exit(0);

    // Fail open: no LSP project → allow Grep
    if (!isLspProject()) process.exit(0);

    const params  = data.tool_input || {};
    const pattern = (params.pattern || '').trim();
    const searchPath = params.path || '';
    const glob    = params.glob || '';

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
      const isPascal = /^[A-Z]/.test(sym);
      if (isPascal) {
        return `  mcp__cclsp__find_workspace_symbols("${sym}")  → find in project\n  mcp__cclsp__find_definition("${sym}")          → go to definition`;
      }
      return `  mcp__cclsp__find_references("${sym}")          → all usages\n  mcp__cclsp__find_definition("${sym}")          → go to definition`;
    }).join('\n');

    process.stderr.write(
      `\n⛔ LSP-FIRST BLOCK: ${symbolParts.length} code symbol(s) in Grep — use LSP instead\n` +
      `Symbols: ${symbolParts.join(', ')}\nLSP tools:\n${suggestions}\n\n`
    );

    console.log(JSON.stringify({
      decision: 'block',
      reason: `LSP-FIRST: Pattern contains code symbol(s) [${symbolParts.join(', ')}]. Use LSP tools:\n${suggestions}`
    }));
  } catch (e) {
    // Fail open on any unexpected error
    process.exit(0);
  }
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

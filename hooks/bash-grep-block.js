#!/usr/bin/env node
'use strict';

// bash-grep-block.js — PreToolUse hook (matcher: Bash)
// Blocks grep/rg/ag/ack with code symbols in shell commands.
// FAIL-OPEN: If cclsp/LSP is not available, allows through.

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
    try { data = JSON.parse(raw); } catch { process.exit(0); }
    if (data.tool_name !== 'Bash') process.exit(0);

    // Fail open: no LSP project → allow bash grep
    if (!isLspProject()) process.exit(0);

    const cmd = (data.tool_input?.command || '').trim();
    if (!/\b(grep|rg|ag|ack)\b/.test(cmd)) process.exit(0);
    if (/\bgit\s+grep\b/.test(cmd)) process.exit(0);
    if (/supabase[\\/]migrations|\.task[\\/]|\.claude[\\/]|node_modules|knowledge-vault/i.test(cmd)) process.exit(0);
    if (/--include=?\S*\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log)\b/i.test(cmd)) process.exit(0);

    const cleaned = cmd.replace(/\\"/g, '"');
    const patternMatch =
      cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*"([^"]+)"/) ||
      cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*'([^']+)'/) ||
      cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:(?:-\w+\s+(?:[a-z]+\s+)?)*?)([A-Z][a-zA-Z]\w+)/);

    if (!patternMatch) process.exit(0);

    const fullPattern = patternMatch[1];
    const parts = fullPattern.split(/\\?\|/).map(p => p.replace(/[.*+?^${}()[\]\\]/g, '').trim()).filter(Boolean);
    const symbols = parts.filter(p => {
      if (p.length < 4 || /\s/.test(p)) return false;
      const skip = [
        /^(TODO|FIXME|HACK|XXX|NOTE)/i,
        /^console\b/, /^import\b/, /^export\b/, /^http/i, /^\d/,
        /^[A-Z_]{3,}$/, /^[a-z]{1,8}$/, /^[a-z]+-[a-z]+/,
      ];
      if (skip.some(rx => rx.test(p))) return false;

      return (/^[a-z][a-zA-Z0-9]{3,}$/.test(p) && /[A-Z]/.test(p)) ||
             /^[A-Z][a-zA-Z][a-zA-Z0-9]{2,}$/.test(p) ||
             /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/i.test(p) ||
             (/^[a-z]+(_[a-z]+){2,}$/.test(p) && p.length >= 9);
    });

    if (symbols.length === 0) process.exit(0);

    const targetsCode =
      /\bsrc[\\/]|\bapp[\\/]|components[\\/]|lib[\\/]|hooks[\\/]|utils[\\/]|services[\\/]|actions[\\/]/i.test(cmd) ||
      /\.tsx?\b|\.jsx?\b/i.test(cmd) ||
      /-t\s+(ts|tsx|js|jsx|typescript|javascript)\b/i.test(cmd) ||
      /--type[= ](ts|tsx|js|jsx|typescript)\b/i.test(cmd) ||
      /\bfind\b.*\b(src|app|components|lib)\b/.test(cmd) ||
      /\bxargs\b.*\b(grep|rg|ag|ack)\b/.test(cmd) ||
      /-exec\s+(grep|rg|ag|ack)\b/.test(cmd);

    const hasNonCodeTarget =
      /\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log|toml|xml)\b/i.test(cmd) &&
      !targetsCode;

    if (!targetsCode && !hasNonCodeTarget) {
      const isSimplePipe = /\|/.test(cmd) && !/xargs|exec/.test(cmd);
      const grepPos = cmd.search(/\b(grep|rg|ag|ack)\b/);
      const pipePos = cmd.indexOf('|');
      if (isSimplePipe && pipePos !== -1 && pipePos < grepPos) {
        const beforePipe = cmd.substring(0, pipePos).trim();
        if (/^(git|npm|npx|pnpm|node|echo|cat\s+\S+\.(?:json|md|txt|log|ya?ml))/i.test(beforePipe) ||
            /^(ls|wc|head|tail|sort|uniq)\b/i.test(beforePipe)) {
          process.exit(0);
        }
      }
    } else if (hasNonCodeTarget) {
      process.exit(0);
    }

    const suggestions = symbols.map(s => {
      const tool = /^[A-Z]/.test(s) ? 'find_workspace_symbols' : 'find_references';
      return `mcp__cclsp__${tool}("${s}")`;
    }).join(', ');

    process.stderr.write(
      `\n⛔ LSP-FIRST: Blocked grep/rg — found ${symbols.length} code symbol(s): ${symbols.join(', ')}\n` +
      `LSP is available. Use: ${suggestions}\n\n`
    );

    console.log(JSON.stringify({
      decision: 'block',
      reason: `LSP-FIRST: Pattern contains code symbols [${symbols.join(', ')}]. Use LSP: ${suggestions}`
    }));
  } catch (e) {
    // Fail open on any unexpected error
    process.exit(0);
  }
});

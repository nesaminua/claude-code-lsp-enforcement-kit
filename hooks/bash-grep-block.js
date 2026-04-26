#!/usr/bin/env node
'use strict';

// bash-grep-block.js — PreToolUse hook (matcher: Bash)
// Blocks grep/rg/ag/ack with code symbols in shell commands.
// Suggests LSP equivalent for the active provider (cclsp / Serena / ...).
// Allows: git grep, non-code paths, non-code file types.

const { buildSuggestion, buildStructuredBlockResponse } = require('./lib/detect-lsp-provider');
const { bashTargetVerdict } = require('./lib/bash-target');

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

  // Scope enforcement to the current project. Parses leading `cd <path>`
  // and explicit path args to grep/rg/ag/ack (or find ... -exec/xargs grep)
  // so commands targeting paths outside CLAUDE_PROJECT_DIR are allowed,
  // even when session cwd is inside the project. See lib/bash-target.js.
  if (bashTargetVerdict(cmd, data.cwd) === 'allow') process.exit(0);

  // Case-insensitive to catch `GREP`, `RG` variants
  if (!/\b(grep|rg|ag|ack)\b/i.test(cmd)) process.exit(0);
  if (/\bgit\s+grep\b/i.test(cmd)) process.exit(0);
  if (/(?:^|[\/\\])(?:supabase[\/\\]migrations|\.task|\.claude|node_modules|knowledge-vault)(?:[\/\\]|$)/i.test(cmd)) process.exit(0);
  if (/--include=?\S*\.(sql|md|json|yaml|yml|txt|env|sh|css|scss|log)\b/i.test(cmd)) process.exit(0);

  const cleaned = cmd.replace(/\\"/g, '"');
  const patternMatch =
    cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*"([^"]+)"/i) ||
    cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:-\S+\s+)*'([^']+)'/i) ||
    cleaned.match(/\b(?:grep|rg|ag|ack)\s+(?:(?:-\w+\s+(?:[a-z]+\s+)?)*?)([A-Z][a-zA-Z]\w+)/i);

  if (!patternMatch) process.exit(0);

  const fullPattern = patternMatch[1];
  // Strip zero-width chars from the matched pattern (already stripped from cmd,
  // but an explicit safety for pattern extraction edge cases).
  // NOTE: split on BOTH `|` and `.` — previously we stripped dots, which merged
  // dotted expressions like `mcp.Tool` into `mcpTool` (camelCase false positive).
  // Now we split on dots so each side is evaluated independently.
  const parts = fullPattern
    .split(/\\?\||\./)
    .map(p => p.replace(ZERO_WIDTH, '').replace(/[*+?^${}()[\]\\]/g, '').trim())
    .filter(Boolean);
  const symbols = parts.filter(p => {
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

  const suggestions = symbols.map(sym => {
    const intent = /^[A-Z]/.test(sym) ? 'symbol_search' : 'references';
    return `  ${sym}:\n${buildSuggestion(sym, intent, '    ')}`;
  }).join('\n');

  process.stderr.write(
    `\n⛔ LSP-FIRST: Blocked grep/rg — found ${symbols.length} code symbol(s): ${symbols.join(', ')}\n` +
    `LSP is always connected. Use:\n${suggestions}\n\n`
  );

  const intent = /^[A-Z]/.test(symbols[0]) ? 'symbol_search' : 'references';
  console.log(JSON.stringify(buildStructuredBlockResponse({
    hook: 'bash-grep-block',
    symbols,
    intent,
    reason: `LSP-FIRST: Pattern contains code symbols [${symbols.join(', ')}]. Use LSP:\n${suggestions}`,
  })));
});

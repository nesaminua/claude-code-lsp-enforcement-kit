#!/usr/bin/env node
'use strict';

// lsp-pre-delegation.js — PreToolUse hook (matcher: Agent)
// Warns/blocks Agent dispatches that lack LSP context in implementation phase.
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

const FORCE_LSP_CONTEXT_AGENTS = [
  'backend-explorer', 'frontend-explorer', 'db-explorer',
];

const EXEMPT_AGENTS = [
  'explore', 'security-reviewer', 'performance-reviewer', 'conventions-reviewer',
  'conflict-detector', 'code-auditor', 'lint-types-checker', 'test-runner',
  'code-reviewer', 'go-reviewer', 'doc-updater', 'architect', 'planner',
  'deep-security-reviewer', 'typescript-reviewer', 'python-reviewer',
  'ai-integration-reviewer', 'supabase-auth-reviewer', 'scraper-reviewer',
  'nextjs-static-reviewer', 'build-error-resolver', 'e2e-runner',
  'performance-optimizer', 'tdd-guide',
];

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    let data;
    try { data = JSON.parse(input); } catch { process.exit(0); }
    if (data.tool_name !== 'Agent') process.exit(0);

    // Fail open: no LSP project → allow Agent without LSP context check
    if (!isLspProject()) process.exit(0);

    const toolInput = data.tool_input || {};
    const prompt = toolInput.prompt || '';
    const subagentType = toolInput.subagent_type || '';
    const isForcedExplorer = FORCE_LSP_CONTEXT_AGENTS.includes(subagentType);

    if (!isForcedExplorer) {
      if (EXEMPT_AGENTS.includes(subagentType)) process.exit(0);
      if (EXEMPT_AGENTS.some(e => subagentType.toLowerCase().includes(e))) process.exit(0);
    }

    if (prompt.length < 200) process.exit(0);

    const isolation = toolInput.isolation || '';
    const cwd = data.cwd || process.cwd();
    const taskDir = path.join(cwd, '.task');

    if (!isForcedExplorer && isolation !== 'worktree') {
      if (!fs.existsSync(taskDir)) process.exit(0);
    }

    let inImplementPhase = isForcedExplorer || isolation === 'worktree';

    if (!inImplementPhase) {
      try {
        const entries = fs.readdirSync(taskDir).filter(e => {
          return e.startsWith('20') && fs.statSync(path.join(taskDir, e)).isDirectory();
        });
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        for (const entry of entries) {
          const folderPath = path.join(taskDir, entry);
          const stat = fs.statSync(folderPath);
          if (stat.mtimeMs < twoHoursAgo) continue;
          const statePath = path.join(folderPath, 'state.json');
          if (fs.existsSync(statePath)) {
            try {
              const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              if (state.phase === 'implement') { inImplementPhase = true; break; }
            } catch {}
          }
          const taskMd = path.join(folderPath, '00-task.md');
          if (fs.existsSync(taskMd)) {
            try {
              const content = fs.readFileSync(taskMd, 'utf8');
              if (/\*{0,2}Phase\*{0,2}:\*{0,2}\s*implement/i.test(content)) { inImplementPhase = true; break; }
            } catch {}
          }
        }
      } catch {}
    }

    if (!inImplementPhase) process.exit(0);

    const hasLspContext =
      /\bLSP CONTEXT\b/i.test(prompt) ||
      /\bSymbol Map\b/i.test(prompt) ||
      /\bdefined\s+at\s+[\w\-\/]+\.\w{2,4}:\d+/i.test(prompt) ||
      /\bcalled\s+from\s+[\w\-\/]+\.\w{2,4}:\d+/i.test(prompt) ||
      /\bused\s+in\s+[\w\-\/]+\.\w{2,4}:\d+/i.test(prompt) ||
      /\bimported\s+(?:in|by)\s+[\w\-\/]+\.\w{2,4}:\d+/i.test(prompt);

    if (hasLspContext) process.exit(0);

    const agentLabel = isForcedExplorer ? `explorer "${subagentType}"` : 'implement agent';
    process.stderr.write(
      `\n⛔ LSP PRE-DELEGATION BLOCK: ${agentLabel} launched WITHOUT LSP CONTEXT\n` +
      `Subagents have NO LSP/MCP access. Resolve symbols first, add "## LSP CONTEXT" to prompt.\n\n`
    );

    const decision = (isForcedExplorer || isolation === 'worktree') ? 'block' : 'warn';
    console.log(JSON.stringify({
      decision,
      reason: `LSP PRE-DELEGATION: ${agentLabel} without "## LSP CONTEXT". Use cclsp first.`
    }));
  } catch (e) {
    // Fail open on any unexpected error
    process.exit(0);
  }
});

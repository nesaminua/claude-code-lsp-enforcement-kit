'use strict';

// Runs a hook the way the CLI does: JSON on stdin, decision on stdout.
// Each run gets a throwaway HOME (and cwd) holding only the MCP config the
// test asks for, so provider detection never reads the developer's real
// ~/.claude.json and results do not depend on the machine.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

function makeHome(servers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-kit-test-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));
  return home;
}

function runHook(hook, toolName, toolInput, { servers = { serena: {} } } = {}) {
  const home = makeHome(servers);
  try {
    const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, hook)], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    const out = r.stdout.trim();
    const response = out ? JSON.parse(out) : null;
    return {
      status: r.status,
      blocked: response?.decision === 'block',
      response,
      stderr: r.stderr,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const bash = command => runHook('bash-grep-block.js', 'Bash', { command });
const grepTool = input => runHook('lsp-first-guard.js', 'Grep', input);

module.exports = { runHook, bash, grepTool };

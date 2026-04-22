#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
RULES_DIR="$CLAUDE_DIR/rules"
STATE_DIR="$CLAUDE_DIR/state"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "=== LSP Enforcement Kit — Install ==="
echo ""

# 1. Create directories
mkdir -p "$HOOKS_DIR" "$HOOKS_DIR/lib" "$RULES_DIR" "$STATE_DIR"
echo "[1/4] Directories ready"

# 2. Copy hooks + shared lib + rule
cp "$SCRIPT_DIR/hooks/"*.js "$HOOKS_DIR/"
cp "$SCRIPT_DIR/hooks/lib/"*.js "$HOOKS_DIR/lib/"
cp "$SCRIPT_DIR/rules/lsp-first.md" "$RULES_DIR/"
echo "[2/4] Copied 7 hooks + lib + 1 rule"

# 3. Merge into settings.json (node for safe JSON manipulation)
node -e "
const fs = require('fs');
const path = '$SETTINGS';

let settings = {};
if (fs.existsSync(path)) {
  try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
}

// Enable plugin
if (!settings.enabledPlugins) settings.enabledPlugins = {};
settings.enabledPlugins['typescript-lsp@claude-plugins-official'] = true;

// Hook entries to add
const preToolUse = [
  { matcher: 'Grep', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-first-guard.js' }] },
  { matcher: 'Glob', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-first-glob-guard.js' }] },
  { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/bash-grep-block.js' }] },
  { matcher: 'Read', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-first-read-guard.js' }] },
  { matcher: 'Agent', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-pre-delegation.js' }] },
];

const postToolUse = [
  {
    matcher: 'mcp__cclsp__find_definition|mcp__cclsp__find_references|mcp__cclsp__find_workspace_symbols|mcp__cclsp__find_implementation|mcp__cclsp__get_hover|mcp__cclsp__get_diagnostics|mcp__cclsp__get_incoming_calls|mcp__cclsp__get_outgoing_calls|mcp__serena__find_symbol|mcp__serena__find_referencing_symbols|mcp__serena__get_symbols_overview',
    hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-usage-tracker.js' }],
  },
];

const sessionStart = [
  { matcher: 'true', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-session-reset.js' }] },
];

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

// Dedupe: skip if command already registered
function hasHook(arr, command) {
  return arr.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command === command)
  );
}

for (const entry of preToolUse) {
  if (!hasHook(settings.hooks.PreToolUse, entry.hooks[0].command)) {
    settings.hooks.PreToolUse.push(entry);
  }
}

for (const entry of postToolUse) {
  if (!hasHook(settings.hooks.PostToolUse, entry.hooks[0].command)) {
    settings.hooks.PostToolUse.push(entry);
  }
}

for (const entry of sessionStart) {
  if (!hasHook(settings.hooks.SessionStart, entry.hooks[0].command)) {
    settings.hooks.SessionStart.push(entry);
  }
}

fs.writeFileSync(path, JSON.stringify(settings, null, 2));
"
echo "[3/4] settings.json updated (merged, not overwritten)"

# 4. Verify
echo "[4/4] Verifying..."
HOOKS_COUNT=$(ls "$HOOKS_DIR"/lsp-*.js "$HOOKS_DIR"/bash-grep-block.js 2>/dev/null | wc -l | tr -d ' ')
RULE_OK=$( [ -f "$RULES_DIR/lsp-first.md" ] && echo "yes" || echo "no" )
PLUGIN_OK=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'));
  console.log(s.enabledPlugins?.['typescript-lsp@claude-plugins-official'] ? 'yes' : 'no');
")

echo ""
echo "  Hooks installed:  $HOOKS_COUNT/7"
echo "  Rule installed:   $RULE_OK"
echo "  Plugin enabled:   $PLUGIN_OK"
echo "  State directory:  $([ -d "$STATE_DIR" ] && echo 'yes' || echo 'no')"
echo ""

if [ "$HOOKS_COUNT" -eq 7 ] && [ "$RULE_OK" = "yes" ] && [ "$PLUGIN_OK" = "yes" ]; then
  echo "Done. Restart Claude Code to activate."
else
  echo "WARNING: Some components missing. Check output above."
fi

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
RULES_DIR="$CLAUDE_DIR/rules"
STATE_DIR="$CLAUDE_DIR/state"
SCRIPTS_DIR="$CLAUDE_DIR/scripts"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "=== LSP Enforcement Kit — Install ==="
echo ""

# 1. Create directories
mkdir -p "$HOOKS_DIR" "$HOOKS_DIR/lib" "$RULES_DIR" "$STATE_DIR" "$SCRIPTS_DIR"
echo "[1/5] Directories ready"

# 2. Copy hooks + shared lib + rule + scripts
cp "$SCRIPT_DIR/hooks/"*.js "$HOOKS_DIR/"
cp "$SCRIPT_DIR/hooks/lib/"*.js "$HOOKS_DIR/lib/"
cp "$SCRIPT_DIR/rules/lsp-first.md" "$RULES_DIR/"
cp "$SCRIPT_DIR/scripts/"*.js "$SCRIPTS_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/scripts/"*.sh "$SCRIPTS_DIR/" 2>/dev/null || true
chmod +x "$SCRIPTS_DIR/"* 2>/dev/null || true
echo "[2/5] Copied 7 hooks + 3 libs + 1 rule + scripts"

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
    // cclsp tools
    matcher: 'mcp__cclsp__find_definition|mcp__cclsp__find_references|mcp__cclsp__find_workspace_symbols|mcp__cclsp__find_implementation|mcp__cclsp__get_hover|mcp__cclsp__get_diagnostics|mcp__cclsp__get_incoming_calls|mcp__cclsp__get_outgoing_calls',
    hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-usage-tracker.js' }],
  },
  {
    // Serena tools
    matcher: 'mcp__serena__find_symbol|mcp__serena__find_referencing_symbols|mcp__serena__get_symbols_overview',
    hooks: [{ type: 'command', command: 'node ~/.claude/hooks/lsp-usage-tracker.js' }],
  },
  {
    // Read tool — for skeleton read tracking (OptiVault)
    matcher: 'Read',
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
echo "[3/5] settings.json updated (merged, not overwritten)"

# 4. Copy scripts requires hooks/lib for imports — verify path works
node -e "require('$HOOKS_DIR/lib/read-cached-context.js')" 2>/dev/null && \
  echo "[4/5] Lib imports verified" || \
  echo "[4/5] WARNING: Lib imports may fail"

# 5. Verify
echo "[5/5] Verifying..."
HOOKS_COUNT=$(ls "$HOOKS_DIR"/lsp-*.js "$HOOKS_DIR"/bash-grep-block.js 2>/dev/null | wc -l | tr -d ' ')
LIBS_COUNT=$(ls "$HOOKS_DIR"/lib/*.js 2>/dev/null | wc -l | tr -d ' ')
RULE_OK=$( [ -f "$RULES_DIR/lsp-first.md" ] && echo "yes" || echo "no" )
PLUGIN_OK=$(node -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'));
  console.log(s.enabledPlugins?.['typescript-lsp@claude-plugins-official'] ? 'yes' : 'no');
")

echo ""
echo "  Hooks installed:  $HOOKS_COUNT/7"
echo "  Libs installed:   $LIBS_COUNT/3"
echo "  Rule installed:   $RULE_OK"
echo "  Plugin enabled:   $PLUGIN_OK"
echo "  State directory:  $([ -d "$STATE_DIR" ] && echo 'yes' || echo 'no')"
echo ""

if [ "$HOOKS_COUNT" -eq 7 ] && [ "$LIBS_COUNT" -eq 3 ] && [ "$RULE_OK" = "yes" ] && [ "$PLUGIN_OK" = "yes" ]; then
  echo "Done. Restart Claude Code to activate."
  echo ""
  echo "To generate project-specific CLAUDE.md protocol:"
  echo "  node ~/.claude/scripts/generate-unified-protocol.js [project-dir]"
  echo ""
  echo "To check hook status:"
  echo "  ~/.claude/scripts/lsp-status.sh"
else
  echo "WARNING: Some components missing. Check output above."
fi

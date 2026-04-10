# LSP Enforcement Kit for Claude Code

> Stop burning tokens on Grep. Make Claude navigate code like an IDE.

## The Problem

Claude Code defaults to **Grep + Read** for code navigation. This works, but it's wasteful:

```
"Where is handleSubmit defined?"

Grep approach:
  Grep("handleSubmit") → 23 matches, ~1500 tokens of output
  Read file1.tsx (wrong) → 2500 tokens
  Read file2.tsx (still wrong) → 2500 tokens
  Read file3.tsx (found it) → 2500 tokens
  ─────────────────────────────────────
  Total: ~9,000 tokens, 4 tool calls

LSP approach:
  find_definition("handleSubmit") → form-actions.ts:42, ~80 tokens
  Read form-actions.ts:35-55 → ~150 tokens
  ─────────────────────────────────────
  Total: ~230 tokens, 2 tool calls
```

**~40x fewer tokens. Same answer.**

A rule in CLAUDE.md saying "use LSP" helps ~60% of the time. Hooks make it 100%.

## Token Savings: Grep vs LSP Per Operation

| Task | Grep approach | LSP approach | Saved |
|------|--------------|--------------|-------|
| Find definition of `handleSubmit` | Grep → 23 matches (~1500 tok) + 2 wrong Reads (~5000 tok) = **~6500 tok** | `find_definition` → file:line (~80 tok) + 1 targeted Read (~500 tok) = **~580 tok** | **91%** |
| Find all usages of `UserService` | Grep → 15 matches (~1200 tok), scan results (~300 tok) = **~1500 tok** | `find_references` → 8 file:line pairs (~150 tok) = **~150 tok** | **90%** |
| Check type of `formData` | Read full file (~2500 tok), search visually = **~2500 tok** | `get_hover` → type signature (~60 tok) = **~60 tok** | **98%** |
| Find component `InviteForm` | Glob (~200 tok) + Grep (~800 tok) + Read wrong file (~2500 tok) = **~3500 tok** | `find_workspace_symbols` → exact location (~100 tok) = **~100 tok** | **97%** |
| Who calls `validateToken`? | Grep → noisy results (~1500 tok) + 3 Reads to verify (~6000 tok) = **~7500 tok** | `get_incoming_calls` → caller list (~200 tok) + 1 Read (~500 tok) = **~700 tok** | **91%** |

## Real-World Data: 1 Week, 2 Projects

Aggregate from a week of development across 2 TypeScript projects:

| Metric | With LSP | Without LSP (estimated) |
|--------|----------|------------------------|
| LSP navigation calls | 39 | — |
| Grep calls on code symbols | 0 (blocked) | ~120 |
| Unique code files Read | 53 | ~180 |
| Estimated navigation tokens | **~85k** | **~320k** |
| **Tokens saved** | | **~235k (~73%)** |

**How the estimate works:**
- Each blocked Grep saves ~1200 tokens of noisy output
- Each avoided Read saves ~1500 tokens of file content loaded into context
- 39 LSP calls cost ~4k tokens total (precise, compact results)
- Without LSP: ~120 Greps + ~180 Reads = ~315k tokens for the same navigation work
- With LSP: 39 nav calls + 53 targeted Reads = ~84k tokens

## Architecture: 4 Hooks + 1 Tracker

```
                    PreToolUse                          PostToolUse
                    ──────────                          ───────────

 Grep call ──→ [lsp-first-guard.js] ──→ BLOCK
                  detects code symbols,
                  suggests LSP equivalent

 Bash(grep) ──→ [bash-grep-block.js] ──→ BLOCK
                  catches grep/rg/ag/ack
                  in shell commands

 Read(.tsx) ──→ [lsp-first-read-guard.js] ──→ GATE
                  5 progressive gates
                  (warmup → orient → nav → surgical)

 Agent(impl) ─→ [lsp-pre-delegation.js] ──→ BLOCK
                  subagents can't access MCP,
                  orchestrator must pre-resolve

 LSP call ─────────────────────────────────────→ [lsp-usage-tracker.js]
                                                   tracks nav_count,
                                                   read_count, state
```

## How Each Hook Works

### 1. `lsp-first-guard.js` — Grep Blocker

**Hook type:** PreToolUse | **Matcher:** `Grep`

Intercepts every Grep call. Detects code symbols in the pattern. Blocks with a suggestion to use the correct LSP tool.

| Pattern | Detected as | Action |
|---------|------------|--------|
| `getUserById` | camelCase symbol | BLOCK |
| `UserService` | PascalCase symbol | BLOCK |
| `router.refresh` | dotted symbol | BLOCK |
| `write_audit_log` | snake_case function | BLOCK |
| `create-folder-modal` | component filename | BLOCK |
| `TODO` | keyword | allow |
| `NEXT_PUBLIC_URL` | env var (SCREAMING_SNAKE) | allow |
| `flex-col` | CSS class | allow |
| `*.md`, `*.json`, `*.sql` | non-code file glob | allow |
| `.task/`, `node_modules/` | non-code path | allow |

**Block message example:**
```
⛔ LSP-FIRST BLOCK: 1 code symbol(s) in Grep — use LSP instead
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Symbols: handleSubmit
LSP tools:
  mcp__cclsp__find_references("handleSubmit")  → all usages
  mcp__cclsp__find_definition("handleSubmit")  → go to definition
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 2. `bash-grep-block.js` — Shell Grep Blocker

**Hook type:** PreToolUse | **Matcher:** `Bash`

Same detection logic, but for `Bash(grep "UserService" src/)`, `Bash(rg handleSubmit)`, etc. Claude sometimes tries to bypass the Grep hook by shelling out.

Allows: `git grep` (history search), non-code paths, non-code file type filters.

### 3. `lsp-first-read-guard.js` — Progressive Read Gate

**Hook type:** PreToolUse | **Matcher:** `Read`

The most sophisticated hook. Forces a "navigate first, read targeted" workflow through 5 gates:

```
Gate 1 — Warmup Required
  No LSP state file → BLOCK
  Must call get_diagnostics(<any .ts file>) first

Gate 2 — Free Orientation (reads 1-2)
  ALLOW — explore freely, no restrictions

Gate 3 — Warning (read 3)
  WARN if no LSP nav calls yet
  "Next Read will be BLOCKED"

Gate 4 — Navigation Required (reads 4-5)
  BLOCK if nav_count < 1
  Must use at least 1 LSP navigation call

Gate 5 — Surgical Mode (reads 6+)
  BLOCK if nav_count < 2
  After 2 nav calls → unlimited reads forever
```

**Session flow:**
```
Session starts
  │
  ├─ Read(page.tsx) → Gate 1 BLOCKS → "warmup required"
  │
  ├─ get_diagnostics(file.ts) → tracker writes warmup_done=true
  │
  ├─ Read(page.tsx) → Gate 2 allows (1 of 2 free)
  ├─ Read(actions.ts) → Gate 2 allows (2 of 2 free)
  ├─ Read(types.ts) → Gate 3 WARNS
  ├─ Read(helpers.ts) → Gate 4 BLOCKS
  │
  ├─ find_workspace_symbols("MyFunc") → tracker: nav_count=1
  │
  ├─ Read(helpers.ts) → unlocked (reads 4-5)
  ├─ Read(utils.ts) → unlocked
  ├─ Read(service.ts) → Gate 5 BLOCKS
  │
  ├─ find_references("MyFunc") → tracker: nav_count=2
  │
  └─ SURGICAL MODE — all Reads unlimited
```

**Always allowed (no gate):**
- Non-code files: `.md`, `.json`, `.yaml`, `.env`, `.sql`, `.css`, `.html`
- Config files: `tsconfig.json`, `next.config.ts`, `package.json`
- Test files: `*.test.ts`, `*.spec.tsx`
- Non-code paths: `.task/`, `.claude/`, `node_modules/`, `__tests__/`

**Dedup:** Reading the same file at different line ranges counts as 1 Read.

### 4. `lsp-pre-delegation.js` — Agent Pre-Resolution

**Hook type:** PreToolUse | **Matcher:** `Agent`

Claude Code subagents **cannot access MCP tools** — this is an architectural limitation of the platform. Without this hook, every delegated agent falls back to Grep+Read, bypassing all LSP enforcement.

```
// BLOCKED — no LSP context
Agent({
  prompt: "Fix handleSubmit in the form component",
  isolation: "worktree"
})

// ALLOWED — pre-resolved LSP context
Agent({
  prompt: `Fix handleSubmit error handling.

    ## LSP CONTEXT (pre-resolved by orchestrator)
    - handleSubmit: defined at form-actions.ts:42, called from page.tsx:15
    - FormComponent: defined at form.tsx:8, used in page.tsx:120`,
  isolation: "worktree"
})
```

**Three enforcement tiers:**

| Tier | Agents | Enforcement |
|------|--------|-------------|
| Force | `frontend-explorer`, `backend-explorer`, `db-explorer` | Always BLOCK without LSP context |
| Standard | Implementation agents, worktree-isolated agents | BLOCK during implement phase |
| Exempt | Reviewers, testers, planners, auditors | Never enforced (read-only) |

### 5. `lsp-usage-tracker.js` — State Tracker

**Hook type:** PostToolUse | **Matcher:** all `mcp__cclsp__*` tools

Tracks successful LSP calls in a per-project state file. Other hooks read this state to make gate decisions.

**State file:** `~/.claude/state/lsp-ready-<md5-hash-of-cwd>`

```json
{
  "cwd": "/path/to/project",
  "warmup_done": true,
  "nav_count": 25,
  "read_count": 38,
  "read_files": ["src/page.tsx", "src/actions.ts"],
  "timestamp": 1775818285727,
  "last_tool": "mcp__cclsp__find_references"
}
```

**Cold start handling:** Detects the cclsp "No Project" error (upstream bug where `find_workspace_symbols` doesn't prime the TypeScript project). Emits a `systemMessage` with the correct fix — call a file-based tool first. It's an ordering bug, not a timing issue.

## Installation

### Option 1: Give the repo to Claude Code (recommended)

```bash
git clone https://github.com/nesaminua/claude-code-lsp-enforcement-kit.git
cd claude-code-lsp-enforcement-kit
```

Then tell Claude Code:

```
Run bash install.sh in this repo to set up LSP enforcement hooks.
```

The install script:
- Copies 5 hooks to `~/.claude/hooks/`
- Copies the LSP-first rule to `~/.claude/rules/`
- **Merges** hook registrations into your existing `~/.claude/settings.json` (won't overwrite your other hooks)
- Enables the built-in `typescript-lsp` plugin
- Creates `~/.claude/state/` for tracking
- Verifies everything at the end

### Option 2: Run the script yourself

```bash
git clone https://github.com/nesaminua/claude-code-lsp-enforcement-kit.git
cd claude-code-lsp-enforcement-kit
bash install.sh
```

Output:
```
=== LSP Enforcement Kit — Install ===

[1/4] Directories ready
[2/4] Copied 5 hooks + 1 rule
[3/4] settings.json updated (merged, not overwritten)
[4/4] Verifying...

  Hooks installed:  5/5
  Rule installed:   yes
  Plugin enabled:   yes
  State directory:  yes

Done. Restart Claude Code to activate.
```

### Option 3: Manual setup

<details>
<summary>Click to expand manual steps</summary>

#### Prerequisites

- Claude Code (CLI, Desktop, or IDE extension)
- TypeScript/JavaScript project

#### Step 1: Copy files

```bash
mkdir -p ~/.claude/hooks ~/.claude/state ~/.claude/rules
cp hooks/*.js ~/.claude/hooks/
cp rules/lsp-first.md ~/.claude/rules/
```

#### Step 2: Enable the plugin

In `~/.claude/settings.json`, add to `enabledPlugins`:

```json
{
  "enabledPlugins": {
    "typescript-lsp@claude-plugins-official": true
  }
}
```

#### Step 3: Register hooks in settings.json

**IMPORTANT:** If you already have hooks, **add** these entries to your existing arrays — don't replace them.

Add to `PreToolUse` array:

```json
{
  "matcher": "Grep",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-first-guard.js" }]
},
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/bash-grep-block.js" }]
},
{
  "matcher": "Read",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-first-read-guard.js" }]
},
{
  "matcher": "Agent",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-pre-delegation.js" }]
}
```

Add to `PostToolUse` array:

```json
{
  "matcher": "mcp__cclsp__find_definition|mcp__cclsp__find_references|mcp__cclsp__find_workspace_symbols|mcp__cclsp__find_implementation|mcp__cclsp__get_hover|mcp__cclsp__get_diagnostics|mcp__cclsp__get_incoming_calls|mcp__cclsp__get_outgoing_calls",
  "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/lsp-usage-tracker.js" }]
}
```

</details>

### Verify

Restart Claude Code, then ask:

```
Where is handleSubmit defined?
```

Expected: Claude uses `find_definition`, NOT Grep. If it tries Grep, you'll see the block message.

## LSP Tool Reference

| Tool | Question It Answers | Output |
|------|-------------------|--------|
| `find_definition` | Where is X defined? | file:line of definition |
| `find_references` | Where is X used? | All file:line usages |
| `find_workspace_symbols` | Find anything named X | All matching symbols in project |
| `find_implementation` | What implements this interface? | Concrete implementations |
| `get_incoming_calls` | What calls X? | All callers with file:line |
| `get_outgoing_calls` | What does X call? | All callees with file:line |
| `get_hover` | What type is X? | Type signature + docs |
| `get_diagnostics` | Any errors in this file? | TypeScript errors/warnings |

## Optional: Python, Go, Rust Support

The built-in plugin only covers TypeScript/JavaScript. For other languages, install `cclsp` — a standalone MCP server that connects Claude Code to any Language Server:

```bash
npm install -g cclsp
```

Then install the language server for your language:

```bash
# Python
pip install python-lsp-server

# Go
go install golang.org/x/tools/gopls@latest

# Rust
rustup component add rust-analyzer
```

Create `~/.config/claude/cclsp.json`:

```json
{
  "servers": [
    {
      "extensions": ["py", "pyi"],
      "command": ["pylsp"]
    },
    {
      "extensions": ["go"],
      "command": ["gopls", "serve"]
    },
    {
      "extensions": ["rs"],
      "command": ["rust-analyzer"]
    }
  ]
}
```

Add to your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "cclsp": {
      "type": "stdio",
      "command": "cclsp",
      "args": []
    }
  }
}
```

The hooks work identically — they detect code symbols by naming convention, not by language. Once `cclsp` is connected, `find_definition`, `find_references`, etc. work across all configured languages.

## FAQ

**Q: Does this work with Python/Go/Rust?**
Out of the box — TypeScript/JavaScript only (built-in plugin). For other languages, install `cclsp` + the language server (see section above). The hooks themselves are language-agnostic.

**Q: What if LSP gives wrong results?**
The hooks don't eliminate Grep — they block Grep for *code symbols*. If LSP returns empty, Claude can still Grep with non-symbol patterns or search non-code files. The Read guard also gives 2 free reads before requiring navigation.

**Q: Won't the Read gate slow down simple tasks?**
After 2 LSP navigation calls, all gates open permanently (surgical mode). This happens within the first 30 seconds of a session. Non-code files (config, tests, docs) are never gated.

**Q: Why block Agent delegation without LSP context?**
Claude Code subagents cannot access MCP tools (architectural limitation). Without pre-resolved context, every delegated agent falls back to exploratory Grep+Read, burning thousands of tokens and bypassing all enforcement.

**Q: Known issues?**
`find_workspace_symbols` fails with "No Project" if called before any file-based LSP tool (cclsp upstream bug). The tracker detects this and tells Claude to call `get_diagnostics` first. Not a timing issue — ordering issue.

## License

MIT

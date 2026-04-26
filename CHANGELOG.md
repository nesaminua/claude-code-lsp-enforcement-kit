# Changelog

All notable changes to the LSP Enforcement Kit. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bash-aware project scope** via new helper `hooks/lib/bash-target.js` and an updated `bash-grep-block.js`. The Bash hook now parses two signals out of the command string before deciding whether to enforce: a leading `cd <path>` or `(cd <path>` (resolved against session cwd, with tilde expansion), and explicit positional path args to `grep`/`rg`/`ag`/`ack` or the start dir of `find ... -exec/xargs grep`. Decision rule: if explicit path args exist, any inside the project enforces; all outside allows. Otherwise the effective cwd (cd target or session cwd) decides. Unparseable `cd` targets (env vars, command substitution) fall back to the session-cwd check, never silent allow. Closes the gap where `cd /sibling-checkout && grep SomeSymbol` was blocked despite targeting a path Serena cannot index. Path canonicalization now walks up to the longest existing ancestor before realpath, so non-existent target paths still match through symlinks like `/tmp -> /private/tmp` on macOS. Tested via `node --test hooks/lib/__tests__/bash-target.test.js` (28 cases).
- **Project-scoped enforcement** via new shared helper `hooks/lib/project-scope.js`. All four blocking hooks (`lsp-first-guard.js`, `lsp-first-glob-guard.js`, `lsp-first-read-guard.js`, `bash-grep-block.js`) now short-circuit to allow when the tool's target path resolves outside `$CLAUDE_PROJECT_DIR`. Rationale: Serena and cclsp index the current project; outside the project they cannot answer the same query, so blocking Grep/Glob/Read/shell-grep leaves the agent with no working alternative. Inside the project, behavior is unchanged. Boundary rule: `realpath` the target and `$CLAUDE_PROJECT_DIR`, then prefix-match on a path-separator boundary, handles symlinks and relative paths consistently. Fail-open when `CLAUDE_PROJECT_DIR` is unset or unresolvable (keeps non-project Claude sessions usable). Missing `path` field on Grep/Glob is treated as inside (it defaults to cwd, which is conventionally the project root).

## [2.3.2] — 2026-04-14

### Added
- **Hero image** `assets/token-savings.png` (1000×988, ~50 KB, 64-color palette) showing the 5-operation savings table and weekly totals at a glance. Placed in the README under the badge row, above the "In Action" code examples. Docs-only release — no code changes.

## [2.3.1] — 2026-04-14

### Changed
- **README redesign** with centered hero section, shields.io badges (`for-the-badge` style), quick-navigation links, and emoji section markers. Docs-only release — no code changes.
- New "In Action" section at the top showing real block-message examples for Grep and Read gates so visitors immediately see what the kit does.
- "Quick Start" promoted to a top-level section right under the hero for 5-second onboarding.

## [2.3.0] — 2026-04-14

### Added
- **File-parametrized warmup calls** in `hooks/lib/detect-lsp-provider.js`. New exported helper `buildFileWarmupCall(filePath)` generates a copy-pasteable, multi-provider warmup call parametrized by the **actual file the agent is about to Read** — not a guessed symbol name from the filename. Works in any project regardless of export conventions. cclsp → `get_diagnostics("<path>")`, Serena → `get_symbols_overview("<path>")`. Both calls double as nav calls for gate counters, simultaneously unblocking Gate 1 and contributing to Gates 4/5.
- **Concrete LSP commands in block messages** (`hooks/lsp-first-read-guard.js`). When a Read is blocked, the error message now includes the exact command to unblock it — parametrized by the blocked file path, not generic advice. Reduces friction from "which symbol should I search for?" to "run this exact command".
- **Actionable 3-step remediation** in `hooks/lsp-pre-delegation.js`. Block reason is now a numbered, copy-pasteable guide: (1) prime LSP, (2) find symbols, (3) add `## LSP CONTEXT` block to agent prompt. Replaces the prior short message + stderr preview.

### Changed
- `lsp-first-read-guard.js` Gate 3 threshold constant `REQUIRE_NAV_1_AT` removed — inlined into gate logic for clarity.
- Block-message formatting tightened to reduce line noise while preserving structured JSON output from v2.2.

## [2.2.0] — 2026-04-11

### Added
- **Windows support** via `install.ps1` — PowerShell port of `install.sh`. Same idempotent merge into `settings.json`, same 7 hooks + lib deployment, works with `pwsh` (cross-platform) or `powershell.exe` on Windows.
- **Health-check script** `scripts/lsp-status.sh` — prints hook installation status, settings registration counts, detected LSP providers, current cwd state (warmup, nav_count, read_count, last tool, flag path), and a verdict on which gate the next Read will hit. First-line diagnostic for "why isn't my Grep blocked?".
- **`CHANGELOG.md`** — structured history in the repo, grep-searchable, browseable without clicking through Releases.
- **`SECURITY.md`** — responsible disclosure policy for security issues in hooks or helpers.
- **Structured JSON output** in block-hook responses. Existing `{decision, reason}` now accompanied by `{hook, symbols, intent, providers, suggestions[]}` for programmatic consumers (monitoring, IDE plugins, dashboards). Backward compatible — human-readable `reason` field unchanged.

### Fixed
- False-positive in `bash-grep-block.js` where regex metacharacter stripping merged dotted symbols like `mcp.Tool` into `mcpTool`, which then looked like camelCase and was incorrectly blocked. Dots are now preserved during symbol extraction.

## [2.1.0] — 2026-04-10

### Added
- **Provider detection** via new shared helper `hooks/lib/detect-lsp-provider.js`. Block-message suggestions now adapt to whichever LSP MCP server(s) the user has installed (cclsp, Serena, both, or neither). Detection reads `~/.claude.json`, `~/.claude/settings.json`, and project-level `.mcp.json` and matches known server names case-insensitively.
- **Serena support out of the box**. Users running [Serena](https://github.com/oraios/serena) (multi-language symbol MCP by Oraios AI, MIT) see correct `mcp__serena__find_symbol`, `find_referencing_symbols`, `get_symbols_overview` suggestions. Tracker counts Serena calls toward `nav_count`.
- **Plugin-wrapped MCP tool names** are now detected. Both `mcp__cclsp__*` (standalone) and `mcp__plugin_<plugin>_<server>__*` (plugin-bundled) forms are matched per the Claude Code MCP naming spec.
- README section "Works with any LSP MCP server" + FAQ entries on Serena and multi-language support.

### Security
From a mandatory `deep-security-reviewer` audit. All findings fixed before release.
- **[MEDIUM]** Type-confusion fail-open: non-string `tool_input.pattern` (number, array) threw `TypeError` in `.trim()`, hook exited code 1, Claude Code treated the crash as **passthrough** — the call was allowed. Fixed with `String(x ?? '').trim()` coercion across all 5 blocking hooks.
- **[LOW]** `knowledge-vault` substring bypass in `lsp-first-glob-guard.js`. Bare substring match let `myknowledge-vaultxxx` bypass symbol checking. Fixed with anchored regex `(?:^|[\/\\])knowledge-vault(?:[\/\\]|$)`.
- **[LOW]** Unicode zero-width character bypass. `*Func\u200BName*` was tokenized as a single non-ASCII token, passed all ASCII symbol regexes, and evaded detection in `lsp-first-glob-guard.js` and `bash-grep-block.js`. Fixed by stripping `[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]` before symbol detection.
- **[LOW]** Pipe-ordering bypass in `bash-grep-block.js`: `echo x | grep SomeCamelFunc` was allowed because the safe-prefix pipe exemption ran before symbol detection. Moved the bypass to fire only when `symbols.length === 0`.
- **[LOW]** Case-sensitive grep detection missed `GREP` / `RG`. Added `/i` flag.

### Confirmed safe (no change needed)
Supply chain, prototype pollution, path traversal, ReDoS, command injection, information disclosure, JSON injection, block-response integrity — all audited, all clean.

## [2.0.0] — 2026-04-10

### Added
- **`hooks/lsp-first-glob-guard.js`** (new) — `PreToolUse:Glob` matcher. Closes the bypass where `Glob("*UserService*")` silently returned files matching code-symbol patterns, letting Claude Read them without ever calling LSP. Parses glob patterns, extracts alphabetic tokens, blocks if any token looks like PascalCase / camelCase / 3+-part snake_case. Allows extension patterns (`*.ts`, `src/**`), lowercase concept patterns (`*subdomain*`, `*auth*`), and framework config filenames.
- **`hooks/lsp-session-reset.js`** (new) — `SessionStart` hook. Deletes `~/.claude/state/lsp-ready-<cwd-hash>` at session start so Gate 1 (warmup) re-fires and `nav_count` resets to zero. Without this, a new session inherited yesterday's `nav_count >= 2` from the 24h-expiring flag and jumped straight into "surgical mode" (unlimited Reads) with zero LSP calls in the new session.
- `install.sh` now registers the new `Glob` PreToolUse matcher and `SessionStart` hook. Counter bumped to 7/7. Still idempotent — safe to re-run on v1 installs to upgrade.
- README: new architecture diagram, sections for the two new hooks, v2 upgrade note, updated manual-setup snippets.

### Why
v1 advertised "100% enforcement" but two silent bypass routes let Claude navigate code without calling LSP at all:
1. Glob had no guard — symbol-by-filename search was unmonitored.
2. Read-guard state persisted for 24h — a new session inherited surgical mode.

Both routes closed.

## [1.0.0] — Earlier

Initial release.
- `hooks/lsp-first-guard.js` — `PreToolUse:Grep` blocker for code symbols.
- `hooks/bash-grep-block.js` — `PreToolUse:Bash` blocker for `grep|rg|ag|ack` with code symbols.
- `hooks/lsp-first-read-guard.js` — `PreToolUse:Read` progressive gate (warmup → orient → nav → surgical).
- `hooks/lsp-pre-delegation.js` — `PreToolUse:Agent` blocker for subagent delegation without pre-resolved `## LSP CONTEXT`.
- `hooks/lsp-usage-tracker.js` — `PostToolUse` tracker for LSP MCP calls.
- `rules/lsp-first.md` — CLAUDE.md rule for LSP-first navigation.
- `install.sh` — idempotent installer with `settings.json` merge.

[Unreleased]: https://github.com/nesaminua/claude-code-lsp-enforcement-kit/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/nesaminua/claude-code-lsp-enforcement-kit/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/nesaminua/claude-code-lsp-enforcement-kit/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/nesaminua/claude-code-lsp-enforcement-kit/releases/tag/v2.0.0

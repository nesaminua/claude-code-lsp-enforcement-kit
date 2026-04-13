This file was authored using Claude Cowork with local copies of the repositories of all four tools involved in this design exercise.
-=@=- -=@=- -=@=- -=@=- -=@=- -=@=- -=@=- -=@=- 
Integration plan for unifying Codesight, OptiVault, LSP Enforcement Kit, and Serena into a coherent developer toolchain for Claude Code.

**Attention Conservation Notice**
For: Neal and anyone evaluating these four tools together
What: A plan to make the LSP enforcement hooks cache-aware, unify the CLAUDE.md protocol, and coordinate all four tools — without rewriting any of them
Action: Read the plan, decide which phase to start with
Skip if: You're looking for a monorepo merge — this plan explicitly avoids that


## The Problem

Four tools that all optimize how Claude navigates code, none designed with awareness of the others. Running them together produces three competing CLAUDE.md sections, redundant extraction work, and no shared decision-making about when to use cached context vs. live LSP queries.

The token cost breakdown matters here. Codesight and OptiVault run locally in milliseconds — their output is free to read from disk. Serena also runs locally (language servers are local processes), but every MCP tool call is a round trip through Claude's context window — Claude formulates the call, receives the result, reasons about it. That's ~200-400 tokens per Serena call. When the answer is already sitting in a cached markdown file, those tokens are wasted.


## What Each Tool Contributes

**Serena** is the authority. It has a live connection to 40+ language servers and provides compiler-accurate symbol operations: find definition, find references, rename, call hierarchy. It's the only tool that can answer "what calls this function across the entire codebase" with certainty. It's also the only tool that can *edit* at the symbol level (replace_symbol_body, rename_symbol). Non-negotiable for precision work.

**Codesight** is the architect. Its 8 parallel detectors extract domain-level concepts that no language server provides: routes with HTTP methods and middleware tags, ORM schemas with field constraints and relations, component props, blast radius analysis. The output in `.codesight/routes.md` answers "what are all the authenticated API endpoints" in a way that `find_symbol` never will.

**OptiVault** is the index. Its per-file skeletons and RepoMap give Claude a compressed map of every file's dependencies and exports. When Claude needs to know "what does `src/auth.ts` export and what does it depend on," the skeleton answers in ~50 tokens. Without it, Claude either reads the whole file (~500-1000 tokens) or makes multiple Serena calls (~600-800 tokens).

**The LSP Enforcement Kit** is the traffic cop. Its hooks intercept Claude's tool calls and enforce navigation discipline. It's the only tool that can *prevent* Claude from wasting tokens on grep chains. Currently it redirects everything to Serena. The enhancement is making it redirect to the cheapest layer that can answer the question.


## Phase 1: Make the Hooks Cache-Aware

This is the highest-value, lowest-effort change. The enforcement hooks already intercept tool calls and extract symbols from them. They already read per-project state from disk. Extending them to also read Codesight and OptiVault output requires ~100-150 lines of JavaScript across 2-3 hook files.

### What Changes

**`lsp-first-guard.js`** (Grep interceptor): When it detects a code symbol in a blocked Grep call, before suggesting Serena, it checks:

1. `_optivault/_RepoMap.md` — is this symbol listed as an export from any file? If yes, include the file path and signature in the block message. Claude gets the answer without making any follow-up call.
2. `.codesight/routes.md` — does this symbol match a route handler name? If yes, include the route info (method, path, middleware tags).
3. `.codesight/schema.md` — does this symbol match a model name? If yes, include the model summary.

If the caches answer the question, the block message says: "Found in cached context: `handleSubmit` is exported from `src/form-actions.ts` with signature `(formData: FormData): Promise<void>`. If you need references or call hierarchy, use Serena." Claude can decide whether the cache is sufficient or whether it needs the live query.

**`lsp-first-read-guard.js`** (Read interceptor): The 5-gate progression currently tracks read count and nav count. Enhance it to also check whether a skeleton exists for the file being read. If `_optivault/src/auth.ts.md` exists, the block message can suggest: "Read the skeleton first (~50 tokens) before reading the full file (~800 tokens). Skeleton at `_optivault/src/auth.ts.md`."

This doesn't change the gate logic — it adds information to the block messages so Claude makes better decisions within the existing progression.

**`lsp-first-glob-guard.js`** (Glob interceptor): When Claude globs for a filename pattern like `*UserService*`, check the RepoMap for matching entries before blocking. If found, return the match directly.

### Implementation Details

Add a shared utility module alongside `detect-lsp-provider.js`:

```
hooks/lib/
  detect-lsp-provider.js   (existing)
  read-cached-context.js   (new)
```

`read-cached-context.js` exports functions:

- `lookupSymbolInRepoMap(cwd, symbol)` — reads `_optivault/_RepoMap.md`, scans for the symbol in export lists. Returns `{ file, signature }` or null. File is read once per session and cached in memory.
- `lookupSymbolInRoutes(cwd, symbol)` — reads `.codesight/routes.md`, scans for handler name matches. Returns `{ method, path, tags }` or null.
- `lookupSymbolInSchema(cwd, symbol)` — reads `.codesight/schema.md`, scans for model name matches. Returns `{ model, fields_summary }` or null.
- `getSkeletonPath(cwd, filePath)` — checks if `_optivault/<relative-path>.md` exists. Returns the path or null.

These are simple file reads with string matching — no parsing libraries, no dependencies. The cached files are small (RepoMap is typically <200 lines, route/schema files are similarly compact). Reading them adds <1ms to hook execution.

### Fallback Behavior

If cached files don't exist (Codesight or OptiVault not installed/not run), the hooks behave exactly as they do today — redirect to Serena. Zero degradation.


## Phase 2: Unified CLAUDE.md Protocol

This is the coordination problem. Three tools append independent sections to CLAUDE.md, producing competing instructions. The fix is a single protocol block that replaces all three.

### The Protocol

One section, with a clear decision tree that Claude follows:

```markdown
# Code Navigation Protocol

This project uses a three-tier navigation system. Follow this order — cheapest first.

## Tier 1: Cached Context (free)
Before any code exploration, check these files:
- `_optivault/_RepoMap.md` — master index of every file's exports and dependencies
- `_optivault/<path>.md` — per-file skeleton with signatures (read instead of full file when possible)
- `.codesight/routes.md` — all HTTP routes with methods, paths, and middleware tags
- `.codesight/schema.md` — all data models with fields, types, and relations
- `.codesight/components.md` — UI components with props
- `.codesight/graph.md` — most-imported files and dependency graph

If the cached context answers your question, stop here.

## Tier 2: Serena LSP (accurate, costs a tool call)
For questions the cache can't answer — references, call hierarchy, implementations, type hover — use Serena:
- `find_symbol` — locate any symbol by name
- `find_referencing_symbols` — all usages across the codebase
- `get_symbols_overview` — file structure and hierarchy
- `rename_symbol` — refactor a name everywhere

The enforcement hooks will block Grep/Glob/Read-before-LSP. Work with them, not around them.

## Tier 3: Direct File Access
After consulting Tier 1 or Tier 2, read specific files at specific line ranges. Prefer reading the skeleton first to identify the exact lines you need.

## After Every Write
Call OptiVault's `sync_file_context` to update the cached skeletons and RepoMap.
Codesight's semantic cache updates on next scan or via watch mode.
Serena's language server updates automatically.
```

### Who Generates This

Options, in order of preference:

**Option A: A small standalone script.** A `generate-protocol.sh` (or `.js`) that detects which tools are present (checks for `_optivault/`, `.codesight/`, Serena in MCP config) and writes one unified protocol block to CLAUDE.md. Run it after running Codesight and OptiVault init. This is the simplest approach — ~50 lines, no changes to any tool's codebase.

**Option B: Extend Codesight's AI config generator.** Codesight already generates CLAUDE.md. Modify its `ai-config.ts` to detect OptiVault and Serena presence and emit the unified protocol instead of just its own section. This couples Codesight to awareness of the other tools, which is a trade-off.

**Option C: Extend OptiVault's generateClaudeMd.** Same idea, different tool as the host.

Option A is recommended. It's a coordination layer, not a feature of any single tool. It can live in the enforcement kit repo (since the kit is already the behavioral coordinator) or in its own small repo.

### Sentinel Strategy

The unified protocol uses its own sentinel: `<!-- unified-nav-protocol -->`. The generation script:

1. Reads existing CLAUDE.md
2. Removes any existing Codesight section (detected by `# AI Context (auto-generated by codesight)`)
3. Removes any existing OptiVault section (detected by `<!-- optivault-protocol -->`)
4. Removes any previous unified protocol section (detected by `<!-- unified-nav-protocol -->`)
5. Appends the unified protocol block
6. Preserves all other content (user-written sections, other tool sections)


## Phase 3: Coordinated Write-Back

When Claude edits a file, three things need to update:

1. **OptiVault skeleton + RepoMap** — via `sync_file_context` MCP tool (~20ms)
2. **Codesight semantic cache** — only if the file is a route/schema/component/config file
3. **Serena's language server** — updates automatically (no action needed)

Currently, OptiVault's CLAUDE.md protocol tells Claude to call `sync_file_context` after every write. This should remain — it's the cheapest update.

For Codesight, full re-scan is milliseconds, but it's not exposed as an MCP tool — it's a CLI command. Two options:

**Option A: Watch mode.** Run `codesight --watch` alongside the session. File changes trigger automatic re-scan. No Claude action needed. This is the zero-friction option.

**Option B: Post-write hook.** Add a PostToolUse hook (matching Write/Edit tools) that shells out to `npx codesight` on the project directory. This couples the enforcement kit to Codesight's CLI, but keeps everything automatic.

Option A is simpler. The unified CLAUDE.md protocol should note that Codesight runs in watch mode and its cached files are always current.


## Phase 4: Enforcement Hook Cascade Enhancement

After Phases 1-3 are working, refine the hook logic to implement a true tiered cascade rather than just enriched block messages.

### Current Behavior

```
Claude calls Grep("handleSubmit") 
  → hook blocks 
  → message: "use find_definition instead"
  → Claude calls Serena
  → Serena answers
```

### Enhanced Behavior

```
Claude calls Grep("handleSubmit")
  → hook blocks
  → hook checks RepoMap: found in src/form-actions.ts
  → hook checks routes.md: matches POST /api/submit [auth, validation]
  → message includes both cached hits + Serena suggestion
  → Claude decides: cache is sufficient OR needs live LSP
```

The hook doesn't *prevent* Claude from calling Serena — it gives Claude enough information to make an informed choice. Sometimes the cache is enough ("where is this defined?"), sometimes it isn't ("what are all the callers of this function?").

### Gate Progression Update

The 5-gate read system in `lsp-first-read-guard.js` should count skeleton reads as "informed reads" — reading `_optivault/src/auth.ts.md` before reading `src/auth.ts` demonstrates navigation discipline, similar to an LSP call. This could count toward the nav_count threshold, allowing Claude to progress through gates faster when it's using the cache effectively.


## What This Plan Does NOT Do

**No monorepo merge.** Codesight, OptiVault, Serena, and the enforcement kit remain separate repos with separate release cycles. The integration is at the file-system level (cached output files) and the behavioral level (hooks + CLAUDE.md protocol).

**No new MCP server.** The hooks read files from disk. Serena is the only MCP server. Codesight and OptiVault are CLI tools that produce files.

**No changes to Serena.** Serena is the language server interface — it does its job. The integration layers are downstream of it.

**No changes to Codesight's detection logic.** Its 8 detectors, AST layer, and framework support stay as-is. The only potential change is making its AI config generator aware of the unified protocol (Phase 2, Option B), which is optional.

**No changes to OptiVault's core.** Its vault generation, mtime caching, and write-back protocol stay as-is.


## Implementation Effort Estimates

| Phase | Scope | Effort | Changes To |
|---|---|---|---|
| Phase 1 | Cache-aware hooks | 1-2 days | Enforcement kit: new shared lib + modify 3 hooks |
| Phase 2 | Unified CLAUDE.md | Half a day | New script (~50-100 lines), or modify one tool's generator |
| Phase 3 | Coordinated write-back | Half a day | Run Codesight in watch mode (config only) or add one PostToolUse hook |
| Phase 4 | Cascade refinement | 1-2 days | Enforcement kit: refine block message logic + gate counting |

Total: 3-5 days of work. No architectural changes. No new dependencies. No breaking changes to any tool.


## File Changes Summary

### Enforcement Kit (claude-code-lsp-enforcement-kit)

New files:
- `hooks/lib/read-cached-context.js` — shared cache lookup functions

Modified files:
- `hooks/lsp-first-guard.js` — import cache lookups, enrich block messages
- `hooks/lsp-first-glob-guard.js` — check RepoMap before blocking
- `hooks/lsp-first-read-guard.js` — suggest skeletons, count skeleton reads toward nav_count

### New Script (location TBD — enforcement kit repo or standalone)

- `scripts/generate-unified-protocol.js` — detects installed tools, writes unified CLAUDE.md section

### Codesight (optional, Phase 3 only)

No code changes. Run with `--watch` flag.

### OptiVault

No code changes.

### Serena

No code changes.

<!-- unified-nav-protocol -->
# Code Navigation Protocol

This project uses a tiered navigation system. Follow this order — cheapest first.

## Tier 1: Cached Context (free)
Before any code exploration, check these files:

**OptiVault** (file skeletons + dependency index):
- `_optivault/_RepoMap.md` — master index of file exports and dependencies
- `_optivault/<path>.md` — per-file skeleton with signatures (~50 tokens vs ~800 for full file)

**Codesight** (domain-level extraction):
- `.codesight/routes.md` — HTTP routes with methods, paths, and middleware tags
- `.codesight/schema.md` — data models with fields, types, and relations
- `.codesight/components.md` — UI components with props
- `.codesight/graph.md` — most-imported files and dependency graph

If the cached context answers your question, **stop here**.

## Tier 2: LSP (accurate, costs a tool call)
For questions the cache can't answer — references, call hierarchy, implementations, type hover — use LSP:

**cclsp**:
| Task | Tool |
|------|------|
| Find definition | `mcp__cclsp__find_definition` |
| Find references | `mcp__cclsp__find_references` |
| Symbol search | `mcp__cclsp__find_workspace_symbols` |
| Implementations | `mcp__cclsp__find_implementation` |
| Hover info | `mcp__cclsp__get_hover` |
| Diagnostics | `mcp__cclsp__get_diagnostics` |
| Incoming calls | `mcp__cclsp__get_incoming_calls` |
| Outgoing calls | `mcp__cclsp__get_outgoing_calls` |

**Serena**:
| Task | Tool |
|------|------|
| Find definition | `mcp__serena__find_symbol` |
| Find references | `mcp__serena__find_referencing_symbols` |
| Symbol search | `mcp__serena__find_symbol` |
| Implementations | `mcp__serena__find_symbol` |
| Incoming calls | `mcp__serena__find_referencing_symbols` |

The enforcement hooks will block Grep/Glob/Read-before-LSP. Work with them, not around them.

## Tier 3: Direct File Access
After consulting Tier 1 or Tier 2, read specific files at specific line ranges.
Prefer reading the skeleton first (`_optivault/<path>.md`) to identify the exact lines you need.

## After Every Write
- Call OptiVault's `sync_file_context` to update cached skeletons and RepoMap
- Codesight's semantic cache updates on next scan or via watch mode (`npx codesight --watch`)
- LSP language server updates automatically

<!-- /unified-nav-protocol -->

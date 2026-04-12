# Debug Logging

LSP Enforcement Kit can log all hook decisions for troubleshooting.

## Log Location

```
~/.claude/logs/lsp-enforcement.log
```

Auto-rotates at 5MB (keeps one `.log.1` backup).

## Enable Logging

### Option 1: settings.json (recommended for VSCode/Antigravity)

Add to `~/.claude/settings.json`:

```json
{
  "lspEnforcementDebug": true
}
```

### Option 2: Environment Variable (CLI)

```bash
LSP_ENFORCE_DEBUG=1 claude
```

Or export for session:

```bash
export LSP_ENFORCE_DEBUG=1
```

## Log Levels

| Level  | What it logs |
|--------|--------------|
| INFO   | Hook invoked, tool intercepted |
| DETAIL | Cache lookups, state reads, symbol detection |
| BLOCK  | Enforcement actions with reasons |
| WARN   | Suggestions emitted |
| ALLOW  | Pass-through decisions |

## Example Output

```
[2026-04-12 14:32:01.234] [INFO  ] [guard] Intercepted Grep | {"pattern":"handleSubmit"}
[2026-04-12 14:32:01.235] [DETAIL] [guard] Cache lookup: routes.md | {"hit":true,"path":"/api/submit"}
[2026-04-12 14:32:01.236] [BLOCK ] [guard] Decision: block | {"reason":"LSP available, found in cache"}
```

## Disable Logging

Remove `lspEnforcementDebug` from settings.json or set to `false`. Unset env var if used.

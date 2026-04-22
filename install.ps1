<#
.SYNOPSIS
    LSP Enforcement Kit installer for Windows (PowerShell).

.DESCRIPTION
    Installs 7 hooks + shared lib to $env:USERPROFILE\.claude\hooks,
    merges hook registrations into $env:USERPROFILE\.claude\settings.json
    (without overwriting existing entries — idempotent), enables the
    typescript-lsp plugin, and creates the state directory.

    Mirrors the behaviour of install.sh on macOS/Linux. Safe to re-run:
    hook entries are deduplicated by command path, so upgrading from an
    older version just adds what's missing.

.EXAMPLE
    pwsh ./install.ps1
    powershell -ExecutionPolicy Bypass -File ./install.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ClaudeDir  = Join-Path $env:USERPROFILE '.claude'
$HooksDir   = Join-Path $ClaudeDir 'hooks'
$HooksLib   = Join-Path $HooksDir  'lib'
$RulesDir   = Join-Path $ClaudeDir 'rules'
$StateDir   = Join-Path $ClaudeDir 'state'
$Settings   = Join-Path $ClaudeDir 'settings.json'

Write-Host '=== LSP Enforcement Kit — Install ===' -ForegroundColor Cyan
Write-Host ''

# 1. Create directories
foreach ($dir in @($HooksDir, $HooksLib, $RulesDir, $StateDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}
Write-Host '[1/4] Directories ready'

# 2. Copy hooks + shared lib + rule
$SourceHooks = Join-Path $ScriptDir 'hooks'
$SourceLib   = Join-Path $SourceHooks 'lib'
$SourceRule  = Join-Path $ScriptDir 'rules\lsp-first.md'

Copy-Item -Path (Join-Path $SourceHooks '*.js') -Destination $HooksDir -Force
Copy-Item -Path (Join-Path $SourceLib   '*.js') -Destination $HooksLib -Force
if (Test-Path $SourceRule) {
    Copy-Item -Path $SourceRule -Destination $RulesDir -Force
}
Write-Host '[2/4] Copied 7 hooks + lib + 1 rule'

# 3. Merge into settings.json
# PowerShell's ConvertFrom-Json returns PSCustomObject; we use hashtables
# for idempotent mutation, then re-serialise.
function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return @{} }
    try {
        $raw = Get-Content -Path $Path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
        $obj = $raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if ($null -eq $obj) { return @{} }
        return $obj
    } catch {
        return @{}
    }
}

function Ensure-Key {
    param([hashtable]$Table, [string]$Key, $Default)
    if (-not $Table.ContainsKey($Key)) { $Table[$Key] = $Default }
}

function Has-HookCommand {
    param([array]$Array, [string]$Command)
    foreach ($entry in $Array) {
        if ($entry -and $entry.hooks) {
            foreach ($h in $entry.hooks) {
                if ($h.command -eq $Command) { return $true }
            }
        }
    }
    return $false
}

$settings = Read-JsonFile -Path $Settings

# Enable plugin
Ensure-Key -Table $settings -Key 'enabledPlugins' -Default @{}
$settings.enabledPlugins['typescript-lsp@claude-plugins-official'] = $true

Ensure-Key -Table $settings -Key 'hooks' -Default @{}
Ensure-Key -Table $settings.hooks -Key 'PreToolUse'   -Default @()
Ensure-Key -Table $settings.hooks -Key 'PostToolUse'  -Default @()
Ensure-Key -Table $settings.hooks -Key 'SessionStart' -Default @()

$preToolUse = @(
    @{ matcher = 'Grep';  hooks = @(@{ type = 'command'; command = 'node ~/.claude/hooks/lsp-first-guard.js' }) },
    @{ matcher = 'Glob';  hooks = @(@{ type = 'command'; command = 'node ~/.claude/hooks/lsp-first-glob-guard.js' }) },
    @{ matcher = 'Bash';  hooks = @(@{ type = 'command'; command = 'node ~/.claude/hooks/bash-grep-block.js' }) },
    @{ matcher = 'Read';  hooks = @(@{ type = 'command'; command = 'node ~/.claude/hooks/lsp-first-read-guard.js' }) },
    @{ matcher = 'Agent'; hooks = @(@{ type = 'command'; command = 'node ~/.claude/hooks/lsp-pre-delegation.js' }) }
)

$postToolUse = @(
    @{
        matcher = 'mcp__cclsp__|mcp__serena__'
        hooks   = @(@{ type = 'command'; command = 'node ~/.claude/hooks/lsp-usage-tracker.js' })
    }
)

$sessionStart = @(
    @{ matcher = 'true'; hooks = @(@{ type = 'command'; command = 'node ~/.claude/hooks/lsp-session-reset.js' }) }
)

foreach ($entry in $preToolUse) {
    if (-not (Has-HookCommand -Array $settings.hooks.PreToolUse -Command $entry.hooks[0].command)) {
        $settings.hooks.PreToolUse += ,$entry
    }
}

foreach ($entry in $postToolUse) {
    if (-not (Has-HookCommand -Array $settings.hooks.PostToolUse -Command $entry.hooks[0].command)) {
        $settings.hooks.PostToolUse += ,$entry
    }
}

foreach ($entry in $sessionStart) {
    if (-not (Has-HookCommand -Array $settings.hooks.SessionStart -Command $entry.hooks[0].command)) {
        $settings.hooks.SessionStart += ,$entry
    }
}

$settings | ConvertTo-Json -Depth 10 | Set-Content -Path $Settings -Encoding UTF8
Write-Host '[3/4] settings.json updated (merged, not overwritten)'

# 4. Verify
Write-Host '[4/4] Verifying...'
$hookFiles = Get-ChildItem -Path $HooksDir -Filter 'lsp-*.js' -ErrorAction SilentlyContinue
$hookFiles += Get-ChildItem -Path $HooksDir -Filter 'bash-grep-block.js' -ErrorAction SilentlyContinue
$hookCount = if ($hookFiles) { $hookFiles.Count } else { 0 }

$ruleOk = Test-Path (Join-Path $RulesDir 'lsp-first.md')
$verify = Read-JsonFile -Path $Settings
$pluginOk = $verify.enabledPlugins -and $verify.enabledPlugins['typescript-lsp@claude-plugins-official'] -eq $true
$stateOk = Test-Path $StateDir

Write-Host ''
Write-Host "  Hooks installed:  $hookCount/7"
Write-Host ('  Rule installed:   ' + $(if ($ruleOk) { 'yes' } else { 'no' }))
Write-Host ('  Plugin enabled:   ' + $(if ($pluginOk) { 'yes' } else { 'no' }))
Write-Host ('  State directory:  ' + $(if ($stateOk) { 'yes' } else { 'no' }))
Write-Host ''

if ($hookCount -eq 7 -and $ruleOk -and $pluginOk) {
    Write-Host 'Done. Restart Claude Code to activate.' -ForegroundColor Green
} else {
    Write-Host 'WARNING: Some components missing. Check output above.' -ForegroundColor Yellow
    exit 1
}

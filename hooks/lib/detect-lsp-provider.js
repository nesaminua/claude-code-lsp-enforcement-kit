'use strict';

/**
 * detect-lsp-provider.js — shared helper for LSP enforcement hooks
 *
 * Detects which LSP-providing MCP servers the user has installed and
 * maps high-level navigation intents ("find definition", "find references")
 * to the correct provider-specific tool names.
 *
 * Supports:
 *   - cclsp         (standalone MCP server, or via typescript-lsp plugin)
 *   - Serena        (https://github.com/oraios/serena — MIT, high-level
 *                    symbol tools, multi-language)
 *   - generic       (fallback — shows neutral hints)
 *
 * Why provider-aware? Before this helper, block messages hardcoded
 * `mcp__cclsp__*` tool names. Users running Serena (or both) saw broken
 * suggestions like "use mcp__cclsp__find_workspace_symbols" even though
 * their LSP tools were actually `mcp__serena__find_symbol`.
 *
 * Detection reads user-level Claude Code config files only. No network,
 * no MCP runtime introspection, no dependency on either provider being
 * installed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// Placeholders for the arguments of a references call that come from the
// result of the find call. Both providers need the symbol's exact name (for
// Serena its name path, e.g. UserService/findOne) and the file that defines
// it, and a grep pattern is often only part of a name (grep "Overview" finds
// DockOverview).
const FROM_FIND = {
  file: '<file from find>',
  name: '<name from find>',
  namePath: '<name_path from find>',
};
const PLACEHOLDERS = new Set(Object.values(FROM_FIND));

// ── Provider registry ──────────────────────────────────────────────────────
// Each entry maps abstract navigation intents to concrete tool names.
// Add new providers here when their MCP servers become popular.
//
// Claude Code MCP tool naming has two forms (verified via anthropics/claude-code docs):
//   mcp__<server>__<tool>                          — standalone server (in ~/.claude.json mcpServers)
//   mcp__plugin_<plugin>_<server>__<tool>          — plugin-bundled server
//
// We handle both by matching the server-name token anywhere after an `mcp__`
// prefix, rather than requiring a fixed prefix string.
const PROVIDERS = {
  cclsp: {
    label:        'cclsp',
    // Preferred prefix for generating NEW suggestions (standalone form).
    prefix:       'mcp__cclsp__',
    // Server-name token for matching EXISTING tool calls. Matches both
    // `mcp__cclsp__*` and `mcp__plugin_*cclsp*__*` variants.
    matchToken:   'cclsp',
    // abstract intent → cclsp tool name
    tools: {
      definition:       'find_definition',
      references:       'find_references',
      symbol_search:    'find_workspace_symbols',
      implementation:   'find_implementation',
      hover:            'get_hover',
      diagnostics:      'get_diagnostics',
      incoming_calls:   'get_incoming_calls',
      outgoing_calls:   'get_outgoing_calls',
    },
    // First call to make on session start — primes the TS project
    warmup: { tool: 'get_diagnostics', note: 'primes TS server (cclsp upstream bug #43 workaround)' },
    // LSP equivalent of a grep for a name; see buildGrepSuggestion.
    // workspace/symbol queries are matched loosely by the language server.
    grep: {
      find: { tool: 'find_workspace_symbols', args: sym => ({ query: sym }) },
      uses: { tool: 'find_references', args: () => ({ file_path: FROM_FIND.file, symbol_name: FROM_FIND.name }) },
    },
  },
  serena: {
    label:        'Serena',
    prefix:       'mcp__serena__',
    matchToken:   'serena',
    tools: {
      // Serena's find_symbol is unified: returns definitions with optional body
      definition:       'find_symbol',
      references:       'find_referencing_symbols',
      symbol_search:    'find_symbol',
      // Serena has no direct cclsp equivalents for these, fall back to find_symbol
      implementation:   'find_symbol',
      hover:             null,
      diagnostics:       null,
      incoming_calls:   'find_referencing_symbols',
      outgoing_calls:    null,
      // Serena-only: high-level "start here" tool
      overview:         'get_symbols_overview',
    },
    // Serena's recommended "first tool to call when understanding a file"
    warmup: { tool: 'get_symbols_overview', note: "Serena's 'first tool to understand a file'" },
    grep: {
      find: { tool: 'find_symbol', args: sym => ({ name_path_pattern: sym, substring_matching: true }) },
      uses: { tool: 'find_referencing_symbols', args: () => ({ name_path: FROM_FIND.namePath, relative_path: FROM_FIND.file }) },
    },
  },
};

// ── Config-file readers ────────────────────────────────────────────────────
function readJsonSilent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function collectMcpServerNames() {
  const names = new Set();
  const candidates = [
    path.join(HOME, '.claude.json'),           // primary Claude Code MCP config
    path.join(HOME, '.claude', 'settings.json'),
    path.join(HOME, '.claude', 'mcp.json'),
    path.join(HOME, '.mcp.json'),              // project-level (cwd fallback)
    path.join(process.cwd(), '.mcp.json'),
  ];

  for (const p of candidates) {
    const data = readJsonSilent(p);
    const servers = data?.mcpServers;
    if (servers && typeof servers === 'object') {
      for (const name of Object.keys(servers)) {
        names.add(String(name).toLowerCase());
      }
    }
  }

  return names;
}

function hasBundledTypescriptLspPlugin() {
  const settings = readJsonSilent(path.join(HOME, '.claude', 'settings.json'));
  return Boolean(settings?.enabledPlugins?.['typescript-lsp@claude-plugins-official']);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns an array of provider keys active on this machine, e.g. ['cclsp'],
 * ['serena'], ['cclsp', 'serena'], or [] if none detected.
 */
function detectProviders() {
  const active = new Set();
  const mcpNames = collectMcpServerNames();

  // cclsp: standalone MCP server OR bundled via typescript-lsp plugin
  if (mcpNames.has('cclsp') || hasBundledTypescriptLspPlugin()) {
    active.add('cclsp');
  }

  // Serena: standalone MCP server registered under the conventional key
  if (mcpNames.has('serena')) {
    active.add('serena');
  }

  return Array.from(active);
}

/**
 * Build a multi-line suggestion block for a given symbol and navigation intent.
 * Shows suggestions for ALL detected providers (or a generic hint if none).
 *
 * @param {string} symbol  The code symbol to navigate to
 * @param {string} intent  One of: 'definition', 'references', 'symbol_search',
 *                         'implementation', 'overview'
 * @param {string} indent  Leading whitespace for each line (default "  ")
 */
function buildSuggestion(symbol, intent, indent = '  ') {
  const providers = detectProviders();

  if (providers.length === 0) {
    return (
      `${indent}(no LSP MCP server detected — install cclsp or Serena)\n` +
      `${indent}Generic: your LSP MCP's find_definition / find_references / find_workspace_symbols`
    );
  }

  const lines = [];
  for (const key of providers) {
    const prov = PROVIDERS[key];
    if (!prov) continue;
    const toolName = prov.tools[intent] || prov.tools.symbol_search;
    if (!toolName) continue;
    lines.push(`${indent}${prov.prefix}${toolName}("${symbol}")  (${prov.label})`);
  }
  return lines.join('\n');
}

// Render a call with its real parameter names, e.g.
//   mcp__serena__find_symbol(name_path_pattern="Foo", substring_matching=true)
// Values go through JSON.stringify, so quotes in a symbol stay escaped.
function formatCall(prefix, tool, args) {
  const list = Object.entries(args)
    .map(([k, v]) => `${k}=${PLACEHOLDERS.has(v) ? v : JSON.stringify(v)}`)
    .join(', ');
  return `${prefix}${tool}(${list})`;
}

/**
 * Suggestion block for a grep that searched for a code symbol.
 *
 * A grep matches a name where it is defined and everywhere it is used, and
 * often as part of longer names, so no single call is its equivalent and
 * the name's casing says nothing about which one was meant. Each provider
 * gets two lines: find the symbol by name or substring, then list the
 * references of the symbol the find returned (its exact name and file).
 */
function buildGrepSuggestion(symbol, indent = '  ') {
  const providers = detectProviders();
  if (providers.length === 0) return buildSuggestion(symbol, 'references', indent);
  if (isFileName(symbol)) return `${indent}(a file name, not a symbol: no LSP call finds it)`;
  const name = searchName(symbol);

  const lines = [];
  for (const key of providers) {
    const prov = PROVIDERS[key];
    if (!prov?.grep) continue;
    for (const step of ['find', 'uses']) {
      const { tool, args } = prov.grep[step];
      lines.push(`${indent}${step}: ${formatCall(prov.prefix, tool, args(name))}  (${prov.label})`);
    }
  }
  return lines.join('\n');
}

// Symbol names hold no dots: the Grep guard's `router.refresh` is found as
// `refresh`.
function searchName(symbol) {
  return String(symbol).split('.').pop();
}

// The Grep guard's dotted shape also matches file names (utils.ts,
// package.json). Their last segment is an extension, and searching symbols
// for "ts" would return every symbol containing it.
const FILE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'md', 'py', 'go', 'rs',
  'java', 'kt', 'rb', 'php', 'cs', 'css', 'scss', 'html', 'yml', 'yaml', 'toml',
  'lock', 'txt', 'sh', 'vue', 'svelte', 'sql', 'xml', 'env',
]);

function isFileName(symbol) {
  const parts = String(symbol).split('.');
  return parts.length > 1 && FILE_EXTENSIONS.has(parts.pop().toLowerCase());
}

/**
 * Get warmup call instructions for Gate 1 in lsp-first-read-guard.js.
 * Returns an array of human-readable lines.
 */
function buildWarmupInstructions(indent = '  ') {
  const providers = detectProviders();

  if (providers.length === 0) {
    return [
      `${indent}No LSP MCP server detected.`,
      `${indent}Install one of:`,
      `${indent}  • cclsp — https://github.com/ktnyt/cclsp (TypeScript/JavaScript)`,
      `${indent}  • Serena — https://github.com/oraios/serena (multi-language)`,
      `${indent}Then call any LSP symbol tool to warm up and unlock Read gates.`,
    ];
  }

  const lines = [];
  for (const key of providers) {
    const prov = PROVIDERS[key];
    if (!prov?.warmup) continue;
    lines.push(`${indent}${prov.prefix}${prov.warmup.tool}(<any project file>)`);
    lines.push(`${indent}  → ${prov.warmup.note}`);
  }
  return lines;
}

/**
 * Build a copy-pasteable warmup call parametrized by the actual file the
 * agent is about to read. File-parametrized calls work in any project
 * without guessing symbol names from filenames — the file path is given
 * by the hook input, and each provider's warmup tool accepts a file arg:
 *   cclsp  → get_diagnostics("<path>")       primes the TS project
 *   serena → get_symbols_overview("<path>")  returns the file's top-level symbols
 *
 * Both calls also count as nav calls for the gate counters, so this
 * simultaneously unblocks Gate 1 and contributes to Gates 4/5.
 *
 * Returns a multi-line string (one line per active provider) or '' if
 * no providers are detected or filePath is empty.
 */
function buildFileWarmupCall(filePath, indent = '  ') {
  if (!filePath) return '';
  const providers = detectProviders();
  if (providers.length === 0) return '';
  const safeFile = String(filePath).replace(/"/g, '\\"');
  const lines = [];
  for (const key of providers) {
    const prov = PROVIDERS[key];
    if (!prov?.warmup) continue;
    lines.push(`${indent}${prov.prefix}${prov.warmup.tool}("${safeFile}")  (${prov.label})`);
  }
  return lines.join('\n');
}

/**
 * Returns a regex fragment that matches tool_name strings for all known
 * providers (used in PostToolUse matcher generation). Matches both
 * standalone and plugin-wrapped forms.
 */
function getTrackerToolNameRegex() {
  const tokens = Object.values(PROVIDERS).map(p => p.matchToken);
  // Match `mcp__<token>__*` OR `mcp__plugin_<anything>_<token>__*`
  return tokens
    .map(tok => `mcp__(?:plugin_[^_]+_)?${tok}__`)
    .join('|');
}

// Pre-compile plugin-wrapped regexes once at module load (perf: avoid
// new RegExp() on every tool call). Keyed by provider matchToken.
const PLUGIN_WRAPPED_RE = new Map();
for (const key of Object.keys(PROVIDERS)) {
  const token = PROVIDERS[key].matchToken;
  PLUGIN_WRAPPED_RE.set(token, new RegExp(`^mcp__plugin_[^_]+_${token}__`));
}

/**
 * Check whether a tool_name string belongs to any known LSP provider.
 * Handles both standalone and plugin-wrapped MCP server naming:
 *   mcp__cclsp__find_definition                       → true (standalone)
 *   mcp__plugin_typescript-lsp_cclsp__find_definition → true (plugin-wrapped)
 *   mcp__serena__find_symbol                          → true
 *   mcp__foo__bar                                     → false
 */
function isLspProviderTool(toolName) {
  if (!toolName || typeof toolName !== 'string') return false;
  if (!toolName.startsWith('mcp__')) return false;
  for (const key of Object.keys(PROVIDERS)) {
    const token = PROVIDERS[key].matchToken;
    // Standalone form: mcp__<token>__
    if (toolName.startsWith(`mcp__${token}__`)) return true;
    // Plugin-wrapped form: mcp__plugin_<plugin>_<token>__  (cached regex)
    const pluginRegex = PLUGIN_WRAPPED_RE.get(token);
    if (pluginRegex && pluginRegex.test(toolName)) return true;
  }
  return false;
}

/**
 * Build a structured list of suggestion objects for programmatic consumers
 * (monitoring, dashboards, IDE plugins). Shape:
 *   [{ provider, label, tool, args, displayTool }]
 *
 * Consumers can render any field or invoke the tool directly from the
 * structured data without parsing human-readable strings.
 */
function buildStructuredSuggestions(symbol, intent) {
  const providers = detectProviders();
  const out = [];
  // Escape embedded quotes so `displayTool` remains a well-formed single
  // call-expression string even if the symbol contains a literal quote.
  // Consumers that invoke programmatically should use `tool` + `args`;
  // `displayTool` is explicitly for human rendering.
  const safeSym = String(symbol).replace(/"/g, '\\"');
  for (const key of providers) {
    const prov = PROVIDERS[key];
    if (!prov) continue;
    const toolName = prov.tools[intent] || prov.tools.symbol_search;
    if (!toolName) continue;
    out.push({
      provider:    key,
      label:       prov.label,
      tool:        `${prov.prefix}${toolName}`,
      args:        { query: String(symbol) },
      displayTool: `${prov.prefix}${toolName}("${safeSym}")`,
    });
  }
  return out;
}

/**
 * Structured form of buildGrepSuggestion. Shape:
 *   [{ provider, label, step: 'find' | 'uses', tool, args, fromFind, displayTool }]
 * `args` uses the provider's real parameter names. `fromFind` lists the args
 * that hold a placeholder ('<name from find>', '<file from find>') to fill in
 * from the result of the 'find' step before the call can run.
 */
function buildStructuredGrepSuggestions(symbol) {
  const out = [];
  if (isFileName(symbol)) return out;
  for (const key of detectProviders()) {
    const prov = PROVIDERS[key];
    if (!prov?.grep) continue;
    for (const step of ['find', 'uses']) {
      const { tool, args } = prov.grep[step];
      const a = args(searchName(symbol));
      out.push({
        provider:    key,
        label:       prov.label,
        step,
        tool:        `${prov.prefix}${tool}`,
        args:        a,
        fromFind:    Object.keys(a).filter(k => PLACEHOLDERS.has(a[k])),
        displayTool: formatCall(prov.prefix, tool, a),
      });
    }
  }
  return out;
}

/**
 * Assemble a structured block response that blocking hooks can emit via
 * console.log(JSON.stringify(...)). Keeps `decision` and `reason` fields
 * intact (backward compatible with existing consumers) while adding rich
 * metadata: `hook`, `symbols`, `intent`, `providers`, `suggestions[]`.
 *
 * @param {object} params
 * @param {string} params.hook       hook filename identifier (e.g. 'lsp-first-guard')
 * @param {string[]} params.symbols  detected code symbols from user input
 * @param {string} params.intent     navigation intent for suggestions
 * @param {string} params.reason     human-readable reason (goes into `reason` field)
 * @param {function} [params.suggestionsFor]  symbol -> structured suggestions;
 *                                   defaults to buildStructuredSuggestions(symbol, intent)
 * @returns {object} JSON-serialisable block response
 */
function buildStructuredBlockResponse({ hook, symbols, intent, reason, suggestionsFor }) {
  const providers = detectProviders();
  const suggestions = [];
  const symbolList = Array.isArray(symbols) ? symbols : [];
  for (const sym of symbolList) {
    const built = suggestionsFor ? suggestionsFor(sym) : buildStructuredSuggestions(sym, intent);
    for (const s of built) {
      suggestions.push({ symbol: String(sym), ...s });
    }
  }
  return {
    decision: 'block',
    reason:   String(reason ?? ''),
    hook:     String(hook ?? ''),
    symbols:  symbolList.map(String),
    intent:   String(intent ?? ''),
    providers,
    suggestions,
  };
}

module.exports = {
  PROVIDERS,
  detectProviders,
  buildSuggestion,
  buildGrepSuggestion,
  buildWarmupInstructions,
  buildFileWarmupCall,
  getTrackerToolNameRegex,
  isLspProviderTool,
  buildStructuredSuggestions,
  buildStructuredGrepSuggestions,
  buildStructuredBlockResponse,
};

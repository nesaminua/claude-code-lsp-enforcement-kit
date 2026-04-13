'use strict';

/**
 * read-cached-context.js — cache layer lookups for Codesight and OptiVault
 *
 * Provides functions to look up symbols and files in cached context produced
 * by external tools:
 *   - Codesight:  .codesight/routes.md, schema.md, components.md
 *   - OptiVault:  _optivault/_RepoMap.md, per-file skeletons
 *
 * All functions gracefully degrade: if cache files don't exist, they return
 * null and the calling hook falls back to LSP-only suggestions.
 *
 * Design principles (matching detect-lsp-provider.js):
 *   - Lazy file reads with in-memory cache (per-process, not per-call)
 *   - Simple string/regex matching, no parsing libraries
 *   - Returns null on missing files (no errors thrown)
 *   - CLI detection via sync exec (for init suggestions)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── In-memory cache ────────────────────────────────────────────────────────
// Cache file contents per cwd to avoid repeated disk reads within a session.
// Shape: { [cwd]: { repoMap: string|null, routes: string|null, schema: string|null, mtime: { ... } } }
const fileCache = new Map();

// ── File readers ───────────────────────────────────────────────────────────
function readFileSilent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function getCachedFile(cwd, relativePath, cacheKey) {
  const fullPath = path.join(cwd, relativePath);

  let entry = fileCache.get(cwd);
  if (!entry) {
    entry = { repoMap: null, routes: null, schema: null, components: null, mtime: {} };
    fileCache.set(cwd, entry);
  }

  // Check mtime to invalidate stale cache
  try {
    const stat = fs.statSync(fullPath);
    const cachedMtime = entry.mtime[cacheKey];
    if (cachedMtime && stat.mtimeMs === cachedMtime) {
      return entry[cacheKey];
    }
    // Read and cache
    const content = readFileSilent(fullPath);
    entry[cacheKey] = content;
    entry.mtime[cacheKey] = stat.mtimeMs;
    return content;
  } catch {
    entry[cacheKey] = null;
    return null;
  }
}

// ── OptiVault lookups ──────────────────────────────────────────────────────

/**
 * Look up a symbol in OptiVault's RepoMap.
 * RepoMap format (expected):
 *   ## src/auth.ts
 *   - exports: AuthService, validateToken, ...
 *   - imports: ...
 *
 * @param {string} cwd - Project root directory
 * @param {string} symbol - Symbol name to find
 * @returns {{ file: string, exports: string }|null}
 */
function lookupSymbolInRepoMap(cwd, symbol) {
  const content = getCachedFile(cwd, '_optivault/_RepoMap.md', 'repoMap');
  if (!content) return null;

  // Parse RepoMap: look for symbol in exports lines
  const lines = content.split('\n');
  let currentFile = null;

  for (const line of lines) {
    // File header: ## path/to/file.ts or ### path/to/file.ts
    const fileMatch = line.match(/^#{2,3}\s+(.+\.\w+)\s*$/);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }

    // Exports line: - exports: Foo, Bar, baz
    // Also handle: exports: Foo, Bar (without leading dash)
    const exportsMatch = line.match(/(?:^-\s*)?exports?:\s*(.+)/i);
    if (exportsMatch && currentFile) {
      const exports = exportsMatch[1];
      // Check if symbol appears in exports (word boundary match)
      const symbolRegex = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
      if (symbolRegex.test(exports)) {
        return { file: currentFile, exports: exports.trim() };
      }
    }
  }

  return null;
}

/**
 * Get the skeleton file path for a given source file, if it exists.
 *
 * @param {string} cwd - Project root directory
 * @param {string} filePath - Relative path to source file (e.g., "src/auth.ts")
 * @returns {string|null} - Path to skeleton file or null if doesn't exist
 */
function getSkeletonPath(cwd, filePath) {
  // Normalize: remove leading ./ or /
  const normalized = filePath.replace(/^\.?\//, '');
  const skeletonPath = path.join(cwd, '_optivault', normalized + '.md');

  if (fs.existsSync(skeletonPath)) {
    return skeletonPath;
  }
  return null;
}

/**
 * Get relative skeleton path for display in messages.
 *
 * @param {string} filePath - Relative path to source file
 * @returns {string} - Relative path to skeleton file
 */
function getSkeletonRelativePath(filePath) {
  const normalized = filePath.replace(/^\.?\//, '');
  return `_optivault/${normalized}.md`;
}

// ── Codesight lookups ──────────────────────────────────────────────────────

/**
 * Look up a symbol in Codesight's routes.md.
 * Routes format (expected):
 *   ## POST /api/users
 *   Handler: createUser
 *   File: src/routes/users.ts:42
 *   Tags: auth, validation
 *
 * @param {string} cwd - Project root directory
 * @param {string} symbol - Handler name to find
 * @returns {{ method: string, path: string, file: string, tags: string[] }|null}
 */
function lookupSymbolInRoutes(cwd, symbol) {
  const content = getCachedFile(cwd, '.codesight/routes.md', 'routes');
  if (!content) return null;

  // Parse routes: sections starting with ## METHOD /path
  const sections = content.split(/(?=^## )/m);

  for (const section of sections) {
    // Check if handler matches symbol
    const handlerMatch = section.match(/Handler:\s*(\w+)/i);
    if (!handlerMatch) continue;

    const handler = handlerMatch[1];
    if (handler.toLowerCase() !== symbol.toLowerCase()) continue;

    // Extract route info
    const routeMatch = section.match(/^## (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/im);
    const fileMatch = section.match(/File:\s*(.+)/i);
    const tagsMatch = section.match(/Tags?:\s*(.+)/i);

    if (routeMatch) {
      return {
        method: routeMatch[1],
        path: routeMatch[2],
        file: fileMatch ? fileMatch[1].trim() : null,
        tags: tagsMatch ? tagsMatch[1].split(/[,\s]+/).filter(Boolean) : [],
      };
    }
  }

  return null;
}

/**
 * Look up a symbol in Codesight's schema.md.
 * Schema format (expected):
 *   ## User
 *   Table: users
 *   Fields:
 *   - id: number (PK)
 *   - email: string (unique)
 *   - name: string
 *
 * @param {string} cwd - Project root directory
 * @param {string} symbol - Model name to find
 * @returns {{ model: string, table: string, fields: string }|null}
 */
function lookupSymbolInSchema(cwd, symbol) {
  const content = getCachedFile(cwd, '.codesight/schema.md', 'schema');
  if (!content) return null;

  // Parse schema: sections starting with ## ModelName
  const sections = content.split(/(?=^## )/m);

  for (const section of sections) {
    const modelMatch = section.match(/^## (\w+)/);
    if (!modelMatch) continue;

    const model = modelMatch[1];
    if (model.toLowerCase() !== symbol.toLowerCase()) continue;

    // Extract schema info
    const tableMatch = section.match(/Table:\s*(\w+)/i);
    const fieldsMatch = section.match(/Fields?:\s*([\s\S]*?)(?=^##|\Z)/m);

    return {
      model,
      table: tableMatch ? tableMatch[1] : null,
      fields: fieldsMatch ? fieldsMatch[1].trim().substring(0, 200) : null, // Truncate for display
    };
  }

  return null;
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Detect which cache layers are available for a project.
 *
 * @param {string} cwd - Project root directory
 * @returns {{ codesight: boolean, optivault: boolean, codesight_cli: boolean, optivault_cli: boolean }}
 */
function detectCacheLayers(cwd) {
  const codesightDir = path.join(cwd, '.codesight');
  const optivaultDir = path.join(cwd, '_optivault');

  return {
    codesight: fs.existsSync(codesightDir),
    optivault: fs.existsSync(optivaultDir),
    codesight_cli: checkCliAvailable('codesight'),
    optivault_cli: checkCliAvailable('optivault'),
  };
}

/**
 * Check if a CLI tool is available (installed globally or via npx).
 * Uses sync exec with short timeout to avoid blocking.
 */
function checkCliAvailable(tool) {
  try {
    // Try global install first, then npx
    execSync(`which ${tool} || npx --yes ${tool} --version`, {
      timeout: 3000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build cache layer suggestions for init.
 * Called by session-reset hook when cache dirs missing but CLI available.
 *
 * @param {string} cwd - Project root directory
 * @returns {string[]} - Array of suggestion messages
 */
function buildCacheInitSuggestions(cwd) {
  const layers = detectCacheLayers(cwd);
  const suggestions = [];

  if (!layers.codesight && layers.codesight_cli) {
    suggestions.push(
      'Codesight CLI available but not initialized.',
      '  Run `npx codesight` to enable cached route/schema navigation.'
    );
  }

  if (!layers.optivault && layers.optivault_cli) {
    suggestions.push(
      'OptiVault CLI available but not initialized.',
      '  Run `npx optivault init` to enable cached skeleton navigation.'
    );
  }

  return suggestions;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a file path is an OptiVault skeleton file.
 * Used by read-guard to detect skeleton reads for gate credit.
 *
 * @param {string} filePath - Absolute or relative file path
 * @returns {boolean}
 */
function isSkeletonPath(filePath) {
  // Match _optivault/**/*.md
  return /[/\\]?_optivault[/\\].+\.md$/.test(filePath);
}

/**
 * Build a formatted cache hit message for inclusion in block messages.
 *
 * @param {string} symbol - The symbol that was looked up
 * @param {object} repoMapHit - Result from lookupSymbolInRepoMap
 * @param {object} routeHit - Result from lookupSymbolInRoutes
 * @param {object} schemaHit - Result from lookupSymbolInSchema
 * @returns {string|null} - Formatted message or null if no hits
 */
function formatCacheHits(symbol, repoMapHit, routeHit, schemaHit) {
  const lines = [];

  if (repoMapHit) {
    lines.push(`  Found in RepoMap: \`${symbol}\` exported from \`${repoMapHit.file}\``);
  }

  if (routeHit) {
    const tags = routeHit.tags.length > 0 ? ` [${routeHit.tags.join(', ')}]` : '';
    lines.push(`  Found in Routes: ${routeHit.method} ${routeHit.path}${tags}`);
    if (routeHit.file) {
      lines.push(`    File: ${routeHit.file}`);
    }
  }

  if (schemaHit) {
    const table = schemaHit.table ? ` (table: ${schemaHit.table})` : '';
    lines.push(`  Found in Schema: ${schemaHit.model}${table}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Look up a symbol across all cache layers.
 * Convenience function that checks RepoMap, Routes, and Schema.
 *
 * @param {string} cwd - Project root directory
 * @param {string} symbol - Symbol to look up
 * @returns {{ repoMap: object|null, routes: object|null, schema: object|null, hasHits: boolean }}
 */
function lookupSymbolInCaches(cwd, symbol) {
  const repoMap = lookupSymbolInRepoMap(cwd, symbol);
  const routes = lookupSymbolInRoutes(cwd, symbol);
  const schema = lookupSymbolInSchema(cwd, symbol);

  return {
    repoMap,
    routes,
    schema,
    hasHits: !!(repoMap || routes || schema),
  };
}

module.exports = {
  // OptiVault
  lookupSymbolInRepoMap,
  getSkeletonPath,
  getSkeletonRelativePath,
  isSkeletonPath,

  // Codesight
  lookupSymbolInRoutes,
  lookupSymbolInSchema,

  // Detection
  detectCacheLayers,
  buildCacheInitSuggestions,

  // Convenience
  lookupSymbolInCaches,
  formatCacheHits,
};

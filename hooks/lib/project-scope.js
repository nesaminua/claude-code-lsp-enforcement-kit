'use strict';

/**
 * project-scope.js — shared helper for scoping hook enforcement to the
 * current Claude Code project.
 *
 * LSP enforcement hooks block Grep/Glob/Read/Bash on the assumption that
 * Serena (or cclsp) can serve the same navigation intent faster and
 * cheaper. That assumption only holds inside the project Serena has
 * indexed. When the agent legitimately needs to read or search files
 * outside the project (system configs, sibling checkouts, temp files),
 * Serena cannot help — blocking the tool leaves no working alternative.
 *
 * This helper answers one question: is the target path inside the
 * current project?
 *
 * Semantics:
 *   - Project root is CLAUDE_PROJECT_DIR, canonicalized via realpath.
 *   - Target path is canonicalized via realpath, resolved against the
 *     session cwd when relative.
 *   - Inside = target equals project root or is a descendant on a
 *     path-separator boundary.
 *   - Fail-open: when CLAUDE_PROJECT_DIR is unset or unresolvable,
 *     returns false so callers allow the tool. Keeps out-of-project
 *     sessions (and non-project Claude invocations) usable.
 *   - Missing target path: returns true. Grep/Glob without an explicit
 *     path default to cwd, which is conventionally the project.
 */

const fs = require('fs');
const path = require('path');

function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function getProjectDir() {
  const raw = process.env.CLAUDE_PROJECT_DIR;
  if (!raw) return null;
  return realpathSafe(raw);
}

/**
 * @param {string|undefined|null} targetPath  Path from tool_input (file_path or path).
 * @param {string|undefined|null} cwd         Session cwd from stdin JSON.
 * @returns {boolean} true when enforcement should apply.
 */
function isInsideProject(targetPath, cwd) {
  const projectDir = getProjectDir();
  if (!projectDir) return false;
  if (!targetPath) return true;
  const abs = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd || process.cwd(), targetPath);
  const resolved = realpathSafe(abs) || abs;
  const withSep = projectDir.endsWith(path.sep) ? projectDir : projectDir + path.sep;
  return resolved === projectDir || resolved.startsWith(withSep);
}

module.exports = { isInsideProject, getProjectDir };

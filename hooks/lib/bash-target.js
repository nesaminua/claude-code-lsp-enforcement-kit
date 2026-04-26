'use strict';

/**
 * bash-target.js — Bash-aware project-scope verdict for bash-grep-block.
 *
 * The Bash hook gets stdin JSON with no `path` field. The previous scope
 * check used `data.cwd` only, which is the session cwd that Claude Code
 * builds for the hook subprocess. Subshell `cd /elsewhere && grep ...`
 * does not change `data.cwd`, so commands that legitimately target paths
 * outside the project still hit the block.
 *
 * This module parses two signals out of the command string:
 *
 *   1. Effective cwd: leading `cd <path>` or `(cd <path>` followed by
 *      `&&` or `;`. Resolved against the session cwd when relative.
 *   2. Explicit path args: positional non-flag args to grep|rg|ag|ack,
 *      or the start dir of `find <path>` when piped or -exec'd into the
 *      grep family.
 *
 * Decision rule:
 *   - If explicit path args exist: ANY inside the project → enforce.
 *     Every path outside → allow.
 *   - Otherwise: use effective cwd (or session cwd if no cd). Inside →
 *     enforce. Outside or missing → allow.
 *
 * Failure mode:
 *   - Unparseable cd target (env vars, command substitution): fall back
 *     to the session cwd check. Never silently fail-open on unparseable
 *     commands; that opens evasion paths.
 *   - CLAUDE_PROJECT_DIR unset: project-scope returns null, verdict is
 *     'allow' (matches existing fail-open semantic).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getProjectDir } = require('./project-scope');

const CD_PREFIX = /^\s*\(?\s*cd\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:&&|;)/;
const FIND_PREFIX = /\bfind\s+(?:'([^']+)'|"([^"]+)"|(\S+))/;
const PATTERN_FLAGS = /^(-e|-f|--regexp|--file)$/;
const VALUE_FLAGS = /^(--include|--exclude|--exclude-dir|--include-dir|-d|--directories)$/;
const EXEC_GREP = /-exec\s+(?:grep|rg|ag|ack)\b/i;
const XARGS_GREP = /\bxargs\b[^|]*\b(?:grep|rg|ag|ack)\b/i;
const EXPANSION = /\$\(|`|\$\{|\$[A-Za-z_]/;

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Canonicalize the longest existing ancestor and rejoin the missing tail.
// Needed because target paths often don't exist yet (grep against a path
// that hasn't been created), but the project root may live under a symlink
// like /tmp -> /private/tmp (macOS) that only canonicalizes when realpath
// can resolve at least one ancestor.
function realpathExisting(p) {
  if (!p) return p;
  let cur = p;
  const tail = [];
  while (cur && cur !== path.dirname(cur)) {
    const r = realpathSafe(cur);
    if (r) return tail.length ? path.join(r, ...tail.reverse()) : r;
    tail.push(path.basename(cur));
    cur = path.dirname(cur);
  }
  return p;
}

function pathIsInsideProject(absPath, projectDir) {
  if (!projectDir || !absPath) return false;
  const resolved = realpathExisting(absPath);
  const root = realpathExisting(projectDir);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(withSep);
}

function tokenize(s) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return tokens;
}

function extractEffectiveCwd(cmd, sessionCwd) {
  const m = String(cmd).match(CD_PREFIX);
  if (!m) return sessionCwd || null;
  const raw = m[1] || m[2] || m[3];
  if (!raw || EXPANSION.test(raw)) return sessionCwd || null;
  const expanded = expandTilde(raw);
  if (path.isAbsolute(expanded)) return expanded;
  if (!sessionCwd) return null;
  return path.resolve(sessionCwd, expanded);
}

function extractGrepTargets(cmd) {
  const cmdStr = String(cmd);

  if (EXEC_GREP.test(cmdStr) || XARGS_GREP.test(cmdStr)) {
    const findMatch = cmdStr.match(FIND_PREFIX);
    if (findMatch) {
      const target = findMatch[1] || findMatch[2] || findMatch[3];
      if (target && !EXPANSION.test(target)) return [target];
    }
  }

  const stripped = cmdStr.replace(CD_PREFIX, '').trim();
  const grepMatch = stripped.match(/\b(grep|rg|ag|ack)\s+(.*)/i);
  if (!grepMatch) {
    const findMatch = cmdStr.match(FIND_PREFIX);
    if (findMatch) {
      const target = findMatch[1] || findMatch[2] || findMatch[3];
      if (target && !EXPANSION.test(target)) return [target];
    }
    return [];
  }

  const tokens = tokenize(grepMatch[2]);
  const paths = [];
  let sawPattern = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (PATTERN_FLAGS.test(t)) { i++; sawPattern = true; continue; }
      if (VALUE_FLAGS.test(t)) { i++; continue; }
      continue;
    }
    if (!sawPattern) { sawPattern = true; continue; }
    if (EXPANSION.test(t)) continue;
    if (t === '{}' || t === ';' || t === '\\;' || t === '+') continue;
    if (/^[|;&)]/.test(t)) break;
    paths.push(t);
  }

  if (paths.length === 0) {
    const findMatch = cmdStr.match(FIND_PREFIX);
    if (findMatch) {
      const target = findMatch[1] || findMatch[2] || findMatch[3];
      if (target && !EXPANSION.test(target)) return [target];
    }
  }
  return paths;
}

function bashTargetVerdict(cmd, sessionCwd) {
  const projectDir = getProjectDir();
  if (!projectDir) return 'allow';

  const effectiveCwd = extractEffectiveCwd(cmd, sessionCwd);
  const targets = extractGrepTargets(cmd);
  const resolveBase = effectiveCwd || sessionCwd || process.cwd();

  if (targets.length > 0) {
    let anyInside = false;
    for (const t of targets) {
      const expanded = expandTilde(t);
      const abs = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(resolveBase, expanded);
      if (pathIsInsideProject(abs, projectDir)) { anyInside = true; break; }
    }
    return anyInside ? 'enforce' : 'allow';
  }

  if (effectiveCwd) {
    return pathIsInsideProject(effectiveCwd, projectDir) ? 'enforce' : 'allow';
  }
  if (!sessionCwd) return 'allow';
  return pathIsInsideProject(sessionCwd, projectDir) ? 'enforce' : 'allow';
}

module.exports = {
  bashTargetVerdict,
  extractEffectiveCwd,
  extractGrepTargets,
  pathIsInsideProject,
};

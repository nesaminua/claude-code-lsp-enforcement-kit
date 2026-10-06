'use strict';

// code-files.js: shared helper for the grep guards.
//
// Decides whether a search target is certainly not code. Built for a guard,
// so it only says yes on positive evidence: the target must end in an
// extension from NON_CODE_EXTENSIONS, formats no LSP server the kit works
// with indexes. Anything else (an unlisted extension, a directory, a dotted
// directory name such as MyApp.Web, a variable, a negated, alternated or
// bracketed glob) may hold code and stays guarded.

const NON_CODE_EXTENSIONS = new Set([
  // already treated as non-code by the guards
  'sql', 'md', 'json', 'jsonc', 'yaml', 'yml', 'txt', 'env', 'sh', 'css', 'scss',
  'log', 'toml', 'xml', 'csv',
  // LaTeX and BibTeX (not .cls: Visual Basic uses it too)
  'tex', 'ltx', 'sty', 'bst', 'bib', 'dtx', 'ins',
  // prose, data and config (not .org: Go vendor paths such as golang.org are
  // directories)
  'markdown', 'rst', 'adoc', 'tsv', 'jsonl', 'ndjson', 'ini', 'cfg', 'conf',
  'lock', 'diff', 'patch', 'svg', 'less', 'sass',
]);

// rg type names (the Grep tool's `type`) whose files are all non-code. Left
// out: md (rg's md type includes .mdx, which holds JSX) and tex (it includes
// .cls, which Apex and Visual Basic use).
const NON_CODE_TYPES = new Set([
  'asciidoc', 'config', 'css', 'csv', 'diff', 'json', 'jsonl', 'less', 'log', 'org',
  'rst', 'sass', 'sh', 'sql', 'svg', 'toml', 'txt', 'xml', 'yaml',
]);

/**
 * True when the target is a file or glob ending in a non-code extension.
 * A leading dot is not an extension: .github is a directory or dotfile.
 */
function isNonCodeTarget(target) {
  const s = String(target ?? '');
  if (s === '' || s === '-' || /[$`!,{}[\]\s]/.test(s)) return false;
  const base = s.split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return NON_CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function isNonCodeType(type) {
  return NON_CODE_TYPES.has(String(type ?? ''));
}

module.exports = { NON_CODE_EXTENSIONS, NON_CODE_TYPES, isNonCodeTarget, isNonCodeType };

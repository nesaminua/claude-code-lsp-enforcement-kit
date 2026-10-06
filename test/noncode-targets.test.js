'use strict';

// A grep whose every target is a non-code file (LaTeX, BibTeX, CSV, ...) is
// not code navigation: no LSP indexes those files, so the suggested LSP call
// cannot answer it. Only positive evidence counts: an extension on the
// non-code list. Anything else may hold code and stays guarded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bash, grepTool } = require('./run-hook');

const allows = [
  "grep -n 'FigureCC4right' chapters/appendix_cc.tex | cut -c1-200",
  'grep -n -E "Rotllan|Uribe|Jebari" bibliography/references.bib | head -60',
  'grep -rn "Escherichia" chapters/*.tex | grep -v corrections',
  'grep -nE "RequirePackage|usepackage" styles/thesis.sty | head -60',
  'grep -n "UserService" data/users.csv 2>/dev/null',
  'grep -n "UserService" ch01.tex ch02.tex',
  'rg -n "UserService" thesis/main.tex',
  'grep -n -e "UserService" ch01.tex',
  'grep -n "UserService" -A 3 ch01.tex',
  'grep -n "classifyAllDescription" src/locales/en/jobs.json',
  // grep applies --include to every file it is given or walks.
  'grep -rn "UserService" --include=*.tex .',
  'grep -rn "UserService" --include=*.tex chapters',
  // rg applies -g inside directories it walks.
  "rg -n 'UserService' -g '*.tex' chapters/",
];

const blocks = [
  // One code file among the targets.
  'grep -n "UserService" src/user.ts notes.tex',
  // Directories, variables, stdin and process substitution may hold code.
  'grep -rn "UserService" chapters/',
  'grep -n "UserService" "$f"',
  'cat src/a.ts | grep -n "getUserById" - a.tex',
  'grep "getUserById" <(cat a.tex; cat src/a.ts)',
  // No operands: the whole tree, or stdin.
  'grep -rn "UserService" --include=*.tex',
  // One code include among the filters.
  'grep -rn "UserService" --include=*.ts --include=*.tex .',
  // rg searches a file it is given whatever -g says.
  "rg -n 'getUserById' -g '*.tex' src/a.ts",
  // rg -g on an operand that may be a file.
  "rg -n 'getUserById' -g '*.tex' src",
  // A non-code first grep does not carry a code grep with it.
  'grep -n "UserService" notes.tex; grep -n "UserService" src/user.ts',
  // Option values are never targets, in any spelling.
  "rg -n 'RiskWarden' --glob '!*.pyc'",
  "rg \"getUserById\" --glob='!*.tex'",
  "rg \"getUserById\" -g='!*.tex'",
  "grep -r \"getUserById\" --exclude='*.tex' src",
  "grep -rn \"getUserById\" --exclude-dir='dist.old' src",
  "ag \"getUserById\" --ignore='*.tex' src",
  'grep -rn "UserService" --exclude "*.bib" src',
  // Options the tables do not know: their values cannot be placed.
  'rg "getUserById" --context-separator x.html',
  'grep -r "getUserById" --frobnicate x.tex',
  // Dotted directory names and dot-directories are not files.
  'rg "getUserById" MyApp.Web',
  'grep -rn "getUserById" Company.Product.Api',
  'grep -rn "gh_to_beads_last" .dev .claude',
  // Code extensions nobody listed are still code.
  'rg getUserById main.tf',
  'rg getUserById build.ps1',
  'rg getUserById api.proto',
  'rg getUserById Index.razor',
  'rg getUserById notebook.ipynb',
  'rg getUserById top.sv',
  // A directory named like a non-code file.
  'grep -rn "getUserById" vendor/golang.org',
];

for (const command of allows) {
  test(`Bash allows: ${command}`, () => {
    const r = bash(command);
    assert.equal(r.blocked, false);
    assert.equal(r.status, 0);
  });
}

for (const command of blocks) {
  test(`Bash blocks: ${command}`, () => {
    assert.equal(bash(command).blocked, true);
  });
}

// The Grep tool runs rg in the session's working directory; `path` is
// resolved from there. These run with the hook's cwd as that directory.
const grepAllows = [
  { pattern: 'UserService', path: 'chapters/ch07.tex' },
  { pattern: 'UserService', glob: '**/*.bib' },
  { pattern: 'UserService', type: 'csv' },
  { pattern: 'UserService', glob: '*.json', type: 'json' },
];

const grepBlocks = [
  { pattern: 'UserService', glob: '**/*.ts' },
  { pattern: 'UserService', path: 'src/' },
  { pattern: 'UserService', path: 'MyApp.Web' },
  { pattern: 'UserService', glob: '!*.tex' },
  { pattern: 'UserService', glob: '*.ts,*.tex' },
  { pattern: 'UserService', glob: '*.{tex,ts}' },
  { pattern: 'UserService', glob: '*.tex', type: 'ts' },
  { pattern: 'UserService', type: 'md' },
  { pattern: 'UserService', path: 'site/index.html' },
  // rg's tex type includes .cls, which Apex and Visual Basic use.
  { pattern: 'UserService', type: 'tex' },
  // Go vendor paths are directories named like domains.
  { pattern: 'UserService', path: '~/golang.org' },
];

for (const input of grepAllows) {
  test(`Grep tool allows: ${JSON.stringify(input)}`, () => {
    const r = grepTool({ ...input, output_mode: 'content' });
    assert.equal(r.blocked, false);
    assert.equal(r.status, 0);
  });
}

for (const input of grepBlocks) {
  test(`Grep tool blocks: ${JSON.stringify(input)}`, () => {
    assert.equal(grepTool({ ...input, output_mode: 'content' }).blocked, true);
  });
}

test('Grep tool: a non-code glob confines a directory path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-kit-dir-'));
  try {
    const input = { pattern: 'UserService', path: dir, glob: '*.tex', output_mode: 'content' };
    assert.equal(grepTool(input).blocked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Grep tool: a non-code glob does not confine a code file path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-kit-dir-'));
  const file = path.join(dir, 'a.ts');
  fs.writeFileSync(file, '');
  try {
    const input = { pattern: 'UserService', path: file, glob: '*.tex', output_mode: 'content' };
    assert.equal(grepTool(input).blocked, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Bash: an existing directory named like a non-code file stays guarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-kit-dir-'));
  const named = path.join(dir, 'proj.conf');
  fs.mkdirSync(named);
  try {
    assert.equal(bash(`grep -rn "getUserById" ${named}`).blocked, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

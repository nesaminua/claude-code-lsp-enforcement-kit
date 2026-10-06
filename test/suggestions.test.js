'use strict';

// A grep matches a name where it is defined and everywhere it is used, and
// often as a substring of longer names. The block message used to pick one
// LSP call from the name's casing (PascalCase got symbol search only,
// camelCase got references only), with an exact-name match. It now names
// both calls: `find` locates the symbol by name or substring, and `uses`
// lists the references of the symbol `find` returned, by its exact name and
// file, with each provider's real parameter names.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runHook, bash, grepTool } = require('./run-hook');

const SERENA_FIND = name =>
  `mcp__serena__find_symbol(name_path_pattern="${name}", substring_matching=true)`;
const SERENA_USES =
  'mcp__serena__find_referencing_symbols(name_path=<name_path from find>, relative_path=<file from find>)';
const CCLSP_FIND = name => `mcp__cclsp__find_workspace_symbols(query="${name}")`;
const CCLSP_USES =
  'mcp__cclsp__find_references(file_path=<file from find>, symbol_name=<name from find>)';

test('a usage lookup of a PascalCase name also offers references', () => {
  const r = bash('grep -in "DockOverview" src/components/Dock.tsx');
  assert.equal(r.blocked, true);
  assert.ok(r.response.reason.includes(`find: ${SERENA_FIND('DockOverview')}`));
  assert.ok(r.response.reason.includes(`uses: ${SERENA_USES}`));
});

test('a substring search finds the longer names, and uses takes the found name path', () => {
  // find_referencing_symbols needs an exact name path: "Overview" alone would
  // fail where find returned DockOverview, so uses takes it from find.
  const r = bash('grep -rn "Overview" src/');
  const lines = r.response.reason.split('\n').map(l => l.trim());
  assert.ok(lines.includes(`find: ${SERENA_FIND('Overview')}  (Serena)`));
  assert.ok(lines.includes(`uses: ${SERENA_USES}  (Serena)`));
});

test('a camelCase name also offers finding its definition', () => {
  const r = bash('grep -rn "getUserById" src/');
  assert.ok(r.response.reason.includes(SERENA_FIND('getUserById')));
  assert.ok(r.response.reason.includes(SERENA_USES));
});

test('cclsp gets its own parameter names', () => {
  const r = runHook('bash-grep-block.js', 'Bash',
    { command: 'grep -in "DockOverview" src/components/Dock.tsx' },
    { servers: { cclsp: {} } });
  assert.ok(r.response.reason.includes(`find: ${CCLSP_FIND('DockOverview')}`));
  assert.ok(r.response.reason.includes(`uses: ${CCLSP_USES}`));
  assert.doesNotMatch(r.response.reason, /serena/);
});

test('with both providers, each gets its find and uses lines', () => {
  const r = runHook('bash-grep-block.js', 'Bash',
    { command: 'grep -rn "getUserById" src/' },
    { servers: { cclsp: {}, serena: {} } });
  const lines = r.response.reason.split('\n').filter(l => /^\s+(find|uses): /.test(l));
  assert.deepEqual(lines.map(l => l.trim().split(' ')[0] + ' ' + l.trim().split(' ')[1].split('(')[0]), [
    'find: mcp__cclsp__find_workspace_symbols',
    'uses: mcp__cclsp__find_references',
    'find: mcp__serena__find_symbol',
    'uses: mcp__serena__find_referencing_symbols',
  ]);
});

test('every symbol in the pattern gets its own block', () => {
  const r = bash('grep -rn "getUserById|UserService" src/');
  assert.ok(r.response.reason.includes(SERENA_FIND('getUserById')));
  assert.ok(r.response.reason.includes(SERENA_FIND('UserService')));
});

test('a dotted name is searched by its last segment', () => {
  // Symbol names hold no dots; "router.refresh" would match nothing.
  const r = grepTool({ pattern: 'router.refresh', output_mode: 'content' });
  assert.equal(r.blocked, true);
  assert.ok(r.response.reason.includes(SERENA_FIND('refresh')));
  assert.ok(!r.response.reason.includes('"router.refresh"'));
});

test('a file name is not turned into a symbol search', () => {
  // The Grep guard blocks utils.ts as a dotted name; searching symbols for
  // its last segment, "ts", would list every symbol containing it.
  const r = grepTool({ pattern: 'utils.ts', output_mode: 'content' });
  assert.equal(r.blocked, true);
  assert.match(r.response.reason, /a file name, not a symbol: no LSP call finds it/);
  assert.doesNotMatch(r.response.reason, /find_symbol|find_referencing_symbols/);
  assert.deepEqual(r.response.suggestions, []);
});

test('a snake_case function gets the same two calls', () => {
  const r = bash('grep -rn "write_audit_log" src/');
  assert.ok(r.response.reason.includes(SERENA_FIND('write_audit_log')));
  assert.ok(r.response.reason.includes(SERENA_USES));
});

test('the Grep tool block names both calls', () => {
  const r = grepTool({ pattern: 'DockOverview', output_mode: 'content' });
  assert.equal(r.blocked, true);
  assert.ok(r.response.reason.includes(SERENA_FIND('DockOverview')));
  assert.ok(r.response.reason.includes(SERENA_USES));
});

test('structured suggestions carry both steps, real argument names and what to fill in', () => {
  const r = bash('grep -in "DockOverview" src/components/Dock.tsx');
  assert.equal(r.response.intent, 'find_and_references');
  assert.deepEqual(r.response.suggestions.map(s => [s.symbol, s.step, s.tool, s.fromFind]), [
    ['DockOverview', 'find', 'mcp__serena__find_symbol', []],
    ['DockOverview', 'uses', 'mcp__serena__find_referencing_symbols', ['name_path', 'relative_path']],
  ]);
  assert.deepEqual(r.response.suggestions[0].args,
    { name_path_pattern: 'DockOverview', substring_matching: true });
});

test('the Glob guard keeps its single exact-name suggestion', () => {
  const r = runHook('lsp-first-glob-guard.js', 'Glob', { pattern: '**/*UserService*' });
  assert.equal(r.blocked, true);
  assert.match(r.stderr, /mcp__serena__find_symbol\("UserService"\)/);
  assert.doesNotMatch(r.stderr, /find:|uses:/);
  // Its structured args ({ query }) are not Serena's parameter names; that
  // predates this change and the Glob guard is out of its scope.
  assert.deepEqual(r.response.suggestions.map(s => [s.tool, s.step]),
    [['mcp__serena__find_symbol', undefined]]);
});

test('with no provider installed the generic hint is unchanged', () => {
  const r = runHook('bash-grep-block.js', 'Bash',
    { command: 'grep -rn "getUserById" src/' }, { servers: {} });
  assert.equal(r.blocked, true);
  assert.match(r.response.reason,
    /\(no LSP MCP server detected — install cclsp or Serena\)\n\s+Generic: your LSP MCP's find_definition \/ find_references \/ find_workspace_symbols/);
});

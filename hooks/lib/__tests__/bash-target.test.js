'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-bashtarget-')));
const project = path.join(tmpRoot, 'project');
const outside = path.join(tmpRoot, 'outside');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(path.join(outside, 'src'), { recursive: true });

process.env.CLAUDE_PROJECT_DIR = project;

const {
  bashTargetVerdict,
  extractEffectiveCwd,
  extractGrepTargets,
} = require('../bash-target');

test('cd into outside project allows', () => {
  assert.equal(bashTargetVerdict(`cd ${outside} && grep packageRoot`, project), 'allow');
});

test('cd into project root enforces', () => {
  assert.equal(bashTargetVerdict(`cd ${project} && grep packageRoot`, project), 'enforce');
});

test('absolute path arg outside project allows', () => {
  assert.equal(bashTargetVerdict(`grep packageRoot ${outside}`, project), 'allow');
});

test('absolute path arg inside project enforces', () => {
  assert.equal(bashTargetVerdict(`grep packageRoot ${project}/src`, project), 'enforce');
});

test('mixed path args (any inside) enforces', () => {
  assert.equal(
    bashTargetVerdict(`grep packageRoot ${outside} ${project}/src`, project),
    'enforce'
  );
});

test('all path args outside project allows', () => {
  assert.equal(
    bashTargetVerdict(`grep packageRoot ${outside} ${outside}/src`, project),
    'allow'
  );
});

test('cd with tilde expansion', () => {
  const home = os.homedir();
  const v = bashTargetVerdict(`cd ~/ && grep packageRoot`, project);
  // home is unlikely to be inside our temp project; expect allow.
  assert.equal(v, home === project ? 'enforce' : 'allow');
});

test('cd with env var falls back to session cwd', () => {
  // session cwd inside project → enforce despite unparseable cd
  assert.equal(bashTargetVerdict(`cd $FOO && grep packageRoot`, project), 'enforce');
  // session cwd outside project → allow
  assert.equal(bashTargetVerdict(`cd $FOO && grep packageRoot`, outside), 'allow');
});

test('cd with command substitution falls back to session cwd', () => {
  assert.equal(bashTargetVerdict(`cd $(pwd) && grep packageRoot`, outside), 'allow');
  assert.equal(bashTargetVerdict(`cd \`pwd\` && grep packageRoot`, project), 'enforce');
});

test('cd with relative path resolves against session cwd', () => {
  // sessionCwd = project, cd ../outside/ → outside
  const sessionCwd = project;
  const rel = path.relative(project, outside);
  assert.equal(bashTargetVerdict(`cd ${rel} && grep packageRoot`, sessionCwd), 'allow');
});

test('parenthesized subshell cd', () => {
  assert.equal(bashTargetVerdict(`(cd ${outside} && grep packageRoot)`, project), 'allow');
  assert.equal(bashTargetVerdict(`(cd ${project} && grep packageRoot)`, outside), 'enforce');
});

test('find piped to xargs grep — start dir outside', () => {
  assert.equal(
    bashTargetVerdict(`find ${outside} -name '*.js' | xargs grep packageRoot`, project),
    'allow'
  );
});

test('find piped to xargs grep — start dir inside', () => {
  assert.equal(
    bashTargetVerdict(`find ${project} -name '*.js' | xargs grep packageRoot`, outside),
    'enforce'
  );
});

test('find -exec grep — start dir outside', () => {
  assert.equal(
    bashTargetVerdict(`find ${outside} -name '*.js' -exec grep packageRoot {} \\;`, project),
    'allow'
  );
});

test('no cd, no path args, session cwd inside enforces', () => {
  assert.equal(bashTargetVerdict(`grep packageRoot`, project), 'enforce');
});

test('no cd, no path args, session cwd outside allows', () => {
  assert.equal(bashTargetVerdict(`grep packageRoot`, outside), 'allow');
});

test('no cd, no path args, session cwd missing allows', () => {
  assert.equal(bashTargetVerdict(`grep packageRoot`, undefined), 'allow');
  assert.equal(bashTargetVerdict(`grep packageRoot`, null), 'allow');
});

test('CLAUDE_PROJECT_DIR unset → allow', () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    assert.equal(bashTargetVerdict(`grep packageRoot ${project}`, project), 'allow');
  } finally {
    process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

test('grep flags with values are skipped', () => {
  // -e PATTERN consumes next token; --include=*.js is single token; pattern then path
  assert.equal(
    bashTargetVerdict(`grep -e packageRoot --include=*.js ${outside}`, project),
    'allow'
  );
  assert.equal(
    bashTargetVerdict(`grep -e packageRoot --include=*.js ${project}/src`, outside),
    'enforce'
  );
});

test('cd outside, then relative path arg', () => {
  // cd /outside && grep Foo src/  → resolves src/ against /outside → outside
  assert.equal(
    bashTargetVerdict(`cd ${outside} && grep packageRoot src/`, project),
    'allow'
  );
});

test('cd outside, then absolute path arg inside project', () => {
  // explicit inside path overrides cd
  assert.equal(
    bashTargetVerdict(`cd ${outside} && grep packageRoot ${project}/src`, project),
    'enforce'
  );
});

test('extractEffectiveCwd: absolute', () => {
  assert.equal(extractEffectiveCwd(`cd /abs/path && grep`, '/sess'), '/abs/path');
});

test('extractEffectiveCwd: no cd returns sessionCwd', () => {
  assert.equal(extractEffectiveCwd(`grep Foo`, '/sess'), '/sess');
});

test('extractEffectiveCwd: env var returns sessionCwd', () => {
  assert.equal(extractEffectiveCwd(`cd $FOO && grep`, '/sess'), '/sess');
});

test('extractGrepTargets: simple', () => {
  assert.deepEqual(extractGrepTargets(`grep Foo /a /b`), ['/a', '/b']);
});

test('extractGrepTargets: skips flag values', () => {
  assert.deepEqual(extractGrepTargets(`grep -e Foo /a`), ['/a']);
});

test('extractGrepTargets: stops at pipe', () => {
  assert.deepEqual(extractGrepTargets(`grep Foo /a | wc -l`), ['/a']);
});

test('extractGrepTargets: find fallback when grep has no path', () => {
  assert.deepEqual(
    extractGrepTargets(`find /scratch -name '*.js' | xargs grep Foo`),
    ['/scratch']
  );
});

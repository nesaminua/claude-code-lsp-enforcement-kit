'use strict';

// What the guards exist to stop. Every change to the grep guards must keep
// these blocking (or allowing) exactly as they do on main.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bash, grepTool } = require('./run-hook');

const blocks = [
  'grep -rn "getUserById" src/',
  'grep -n "UserService" src/services/user.ts',
  "rg -n 'handleSubmit' src/",
  'rg handleSubmit src/',
  'grep -rn "write_audit_log" src/',
  'find src -name "*.ts" | xargs grep -n "getUserById"',
];

const allows = [
  'git grep -n "UserService"',
  'grep -rn "TODO" src/',
  'grep -rn "NEXT_PUBLIC_URL" src/',
  'grep -rn "UserService" ./node_modules/',
  'grep -rn "UserService" --include=*.md .',
  'grep -n "UserService" notes.md',
];

for (const command of blocks) {
  test(`Bash blocks: ${command}`, () => {
    assert.equal(bash(command).blocked, true);
  });
}

for (const command of allows) {
  test(`Bash allows: ${command}`, () => {
    const r = bash(command);
    assert.equal(r.blocked, false);
    assert.equal(r.status, 0);
  });
}

test('Grep tool blocks a content search for a symbol', () => {
  assert.equal(grepTool({ pattern: 'getUserById', output_mode: 'content' }).blocked, true);
});

test('Grep tool allows a lowercase phrase', () => {
  assert.equal(grepTool({ pattern: 'session expired', output_mode: 'content' }).blocked, false);
});

test('Grep tool allows non-code globs', () => {
  assert.equal(grepTool({ pattern: 'UserService', glob: '*.md', output_mode: 'content' }).blocked, false);
});

test('a block carries the provider suggestion', () => {
  const r = bash('grep -rn "getUserById" src/');
  assert.match(r.response.reason, /mcp__serena__/);
});

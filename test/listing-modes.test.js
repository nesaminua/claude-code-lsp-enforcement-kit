'use strict';

// Greps whose output is file names, counts or nothing at all print no matched
// lines, so there is no output for LSP to shrink. They are allowed. Every
// invocation in a command is checked on its own, so a listing grep cannot
// carry a content grep past the guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bash, grepTool } = require('./run-hook');

const allows = [
  // A file triage loop: which test files use the store and set up beforeAll.
  'for f in $(grep -rl "useAppStore" src --include=*.test.ts --include=*.test.tsx); do\n' +
    '  if grep -q "beforeAll" "$f"; then echo "beforeAll: $f"; fi; done',
  'grep -rl "AppStore" src --include=*.test.ts --include=*.test.tsx',
  'grep -l "UserService" src/',
  'grep -L "UserService" src/',
  'grep -rnl "UserService" src/',
  'grep --files-with-matches "UserService" src/',
  'grep -c "getUserById" src/services/user.ts',
  'grep -q "getUserById" src/services/user.ts',
  'rg -l UserService src/',
  'rg --count-matches "UserService" src/',
  'rg --files-without-match "UserService" src/',
  'ag -l "UserService" src/',
  'ack -c "UserService" src/',
  // grep, rg, ag and ack all read options after the pattern too.
  'grep -n "UserService" src/ -l',
  'rg -n "UserService" src/services -l',
  // Listing commands with no content search at all.
  'rg --files src/',
  'ag -g UserService',
  'ack -f src/',
  // Unquoted operands from a loop or a substitution: still a count or a list.
  'for f in src/*.py; do b=$(grep -c "BaseCollector)" $f); echo "$f $b"; done',
  'grep -lE "localStorage|HTMLElement" $(find . -name "*.test.ts") | sort',
  // A label that mentions grep does not undo the listing grep after it.
  'echo "=== grep usages ==="; grep -rl "UserService" src',
];

const blocks = [
  // rg's -L is --follow: it still prints matched lines.
  'rg -L "UserService" src/',
  // rg's -r takes a value, so -rl is "replace with l", not a listing flag.
  'rg -rl "UserService" src/',
  // -A takes a value; the l after it is that value.
  'grep -A1l "UserService" src/',
  // A -l that is another option's value is not a listing flag.
  'rg -g -l "getUserById" src/x.ts',
  'rg -r -l "getUserById" src/x.ts',
  // A -l in a comment or in another command is not an option.
  'rg getUserById src/x.ts # -l',
  'rg getUserById src/x.ts `ls -l`',
  // After --, a -l is a file name.
  'rg -n "UserService" -- src/ -l',
  // With POSIXLY_CORRECT, grep stops reading options at the first operand.
  'POSIXLY_CORRECT=1 grep -n "UserService" src/ -l',
  'export POSIXLY_CORRECT=1; grep -n "getUserById" src -l',
  // A listing grep feeding a content grep: the second one prints lines.
  'grep -rl "x" src/ | xargs grep -n "getUserById"',
  'grep -l "a" src/; grep -n "getUserById" src/',
];

for (const command of allows) {
  test(`Bash allows: ${command.split('\n')[0]}`, () => {
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

test('Grep tool allows files_with_matches', () => {
  assert.equal(grepTool({ pattern: 'UserService', output_mode: 'files_with_matches' }).blocked, false);
});

test('Grep tool allows the default output mode, which is files_with_matches', () => {
  assert.equal(grepTool({ pattern: 'UserService' }).blocked, false);
});

test('Grep tool allows count', () => {
  assert.equal(grepTool({ pattern: 'UserService', output_mode: 'count' }).blocked, false);
});

test('Grep tool still blocks an unknown output mode', () => {
  assert.equal(grepTool({ pattern: 'UserService', output_mode: 'lines' }).blocked, true);
});

test('a Bash block names the allowed listing route', () => {
  assert.match(bash('grep -rn "getUserById" src/').response.reason, /grep -l lists them and is not blocked/);
});

test('a Grep tool block names the allowed listing route', () => {
  const r = grepTool({ pattern: 'getUserById', output_mode: 'content' });
  assert.match(r.response.reason, /"files_with_matches" \(the default\) lists them and is not blocked/);
});

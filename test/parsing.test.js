'use strict';

// Each grep/rg/ag/ack invocation is parsed with its tool's own option table
// and judged on its own. Every command in `newlyBlocked` is a content search
// for a code symbol that the whole-command regexes let through.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bash } = require('./run-hook');

const newlyBlocked = [
  // A bare pattern after a flag was read as the flag's value.
  'grep -rn getUserById src/',
  'rg -n UserService src/',
  // A separate --include value was read as the pattern.
  "grep -rn --include '*.ts' \"getUserById\" .",
  // A quoted option value before the pattern was read as the pattern.
  "rg -g '!*.tex' \"getUserById\" src/",
  // Only the first pattern found was checked.
  "grep -rn \"x\" src/; grep -rn 'getUserById' src/",
  // `git grep` or an exempt path anywhere excused every grep in the command.
  'git grep -n x; grep -rn getUserById src/',
  'echo node_modules/; grep -rn getUserById src/',
  'grep -rn getUserById node_modules/ src/',
  // Commands inside commands.
  'bash -c "grep -rn getUserById src"',
  'cat <<EOF | bash\ngrep -rn getUserById src\nEOF',
  'echo "$(grep -rn getUserById src/)"',
  // egrep and friends are grep.
  'egrep -rn "getUserById" src/',
  'GREP -rn getUserById src/',
  // An option the tables do not know: any word may be the pattern.
  'grep --frobnicate -n getUserById src/',
  // An unquoted expansion before the pattern may hold options that move it.
  'grep $OPTS getUserById src/',
  // Mentions the parser does not account for get the old check where they are.
  `ssh host "grep -rn 'getUserById' /app/src"`,
  'docker exec c grep -rn "getUserById" /app/src',
  'kubectl exec p -- grep -rn "getUserById" src',
  'setsid grep -rn "getUserById" src',
  'function f { grep -rn "getUserById" src; }; f',
  `trap 'grep -rn "getUserById" src' EXIT`,
  `python3 -c "import os; os.system('grep -rn \\"getUserById\\" src')"`,
  `bash <<< 'grep -rn "getUserById" src/'`,
  `echo 'grep -rn "getUserById" src' | bash`,
  'echo $(case x in x) grep -rn "getUserById" src;; esac)',
  // Commands hidden in expansions.
  'echo ${x:-$(grep -rn "getUserById" src)}',
  'echo $(( $(grep -rn "getUserById" src | wc -l) + 1 ))',
  'FOO=$HOME grep -rn "getUserById" src',
  // Wrapper options that take a value.
  'xargs -i grep "getUserById" {}',
  'xargs --max-args 1 grep "getUserById"',
  'sudo --user bob grep -rn "getUserById" src',
  'timeout --signal KILL 5 grep -rn "getUserById" src',
  'stdbuf -o L grep -rn "getUserById" src',
  'exec -a x grep -rn "getUserById" src',
  `bash -c -- 'grep -rn "getUserById" src'`,
  // ag's -A takes a value only when it is a number.
  'ag -A "getUserById" src',
  // An exempt path that leads back out is not exempt.
  'grep -rn "getUserById" node_modules/../src',
  'grep -rn "getUserById" .claude/../src',
  // git runs these greps; only `git grep` itself is exempt.
  "git submodule foreach grep -rn 'getUserById' .",
  "git bisect run grep -rn 'getUserById' src",
  "git rebase -x grep -rn 'getUserById' src",
];

const stillAllowed = [
  // An exempt path no longer needs a slash in front of it.
  'grep -rn "UserService" node_modules/',
  'grep -rn "UserService" ./node_modules/ .claude/',
  'git grep -n getUserById',
  'echo "grep the logs for UserService"',
  'grep -rn "TODO" src/',
  // The pattern comes from a file: nothing to check.
  'grep -rn -f patterns src/',
  // A mention that is only text is not a grep.
  'echo "=== grep results ==="; grep -rn "TODO" src/',
  'cat hooks/bash-grep-block.js | head',
  // git grep, past git's own options.
  'git -C ../repo grep -n getUserById',
  'git --no-pager grep -n getUserById',
];

for (const command of newlyBlocked) {
  test(`blocks: ${command.split('\n')[0]}`, () => {
    assert.equal(bash(command).blocked, true);
  });
}

for (const command of stillAllowed) {
  test(`allows: ${command}`, () => {
    const r = bash(command);
    assert.equal(r.blocked, false);
    assert.equal(r.status, 0);
  });
}

test('text the parser cannot tokenize still gets the old check', () => {
  // The unmatched quote makes the command untokenizable.
  assert.equal(bash("echo 'x; grep -rn \"getUserById\" src/").blocked, true);
});

test('a very long command is parsed in linear time', () => {
  const command = 'rg -a "Ab" '.repeat(20000);
  const start = process.hrtime.bigint();
  bash(command);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 2000, `took ${ms} ms`);
});

// Text that was unquoted or unescaped before parsing (sh -c, eval,
// backticks) no longer lines up with the command, so a parsed grep in it
// must not vouch for a different, unparsed grep the shifted spans land on.
// The shift depends on the padding, so a range of paddings is tried.
test('padding inside sh -c, eval or backticks cannot hide a grep', () => {
  for (let n = 1; n <= 30; n++) {
    const cases = [
      'bash -c "' + '\\"\\" '.repeat(n) + 'ssh h grep \\"getUserById\\" src; grep -l x f"',
      'bash -c ' + "''".repeat(n) + `'ssh h grep "getUserById" src; grep -l x f'`,
      'eval ' + "'' ".repeat(n) + `'ssh h "grep getUserById src"' ';' 'grep -l x ${'f'.repeat(200)}'`,
      'echo `' + '\\\\'.repeat(n) + `ssh h "grep getUserById src"; grep -l x ${'f'.repeat(200)}` + '`',
    ];
    for (const command of cases) {
      assert.equal(bash(command).blocked, true, `n=${n}: ${command.slice(0, 80)}`);
    }
  }
});

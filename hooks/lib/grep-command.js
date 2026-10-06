'use strict';

// grep-command.js: shared helper for bash-grep-block.js.
//
// Reads a shell command the way the shell would, far enough to find every
// grep/rg/ag/ack invocation in it (including inside $(...), backticks,
// <(...), heredoc bodies, `sh -c` strings, `eval`, xargs and find -exec), and
// parses each invocation's arguments with that tool's own option table.
//
// Built for a guard, so it fails closed:
//   - an option it does not know, or a value it cannot place, marks the
//     invocation `conservative`; the caller then treats every word as a
//     possible pattern and skips nothing on the strength of the parse;
//   - every mention of a grep-family name that no parsed invocation accounts
//     for (inside `ssh host "..."`, `docker exec`, a wrapper it does not
//     know, text it cannot tokenize) comes back in `unaccounted`, for the
//     caller to check the old way. The parse can only refine a decision
//     about text it understood, never skip text it did not.

const MAX_DEPTH = 8;

const words = s => new Set(s.split(' '));

// Option tables, from each tool's own documentation or source:
//   grep: macOS/FreeBSD grep(1) and GNU grep(1), merged
//   rg:   rg --help (ripgrep 15)
//   ag:   the_silver_searcher src/options.c (getopt_long string, longopts)
//   ack:  ack3 lib/App/Ack/ConfigLoader.pm (Getopt::Long spec)
//
// shortValue          takes a value: -A 3, -A3
// shortOptionalNumber takes an optional number: -C, -C 3, -C3 (ack)
// longValue           takes a value: --glob X, --glob=X
// longEqualsOnly      takes a value only as --opt=X (getopt optional_argument)
// longOptionalNumber  takes the next word only if it is a number (ack)
// ambiguous           value handling differs between implementations
// roles               what an option means to the guard
const TOOLS = {
  grep: {
    shortValue: 'ABCDdefm',
    shortOptionalNumber: '',
    shortBool: 'abcEFGHhIiJLlMnOoPpqRrSsTUuVvwXxyZz',
    longValue: words('after-context before-context binary-files context devices directories exclude exclude-dir exclude-from file group-separator include include-dir label max-count regexp'),
    longEqualsOnly: words('color colour'),
    longOptionalNumber: new Set(),
    longBool: words('basic-regexp binary byte-offset bz2decompress count decompress dereference-recursive extended-regexp files-with-matches files-without-match fixed-strings help ignore-case initial-tab line-buffered line-number line-regexp lzma mmap no-filename no-group-separator no-ignore-case no-messages null null-data only-matching perl-regexp quiet recursive silent text version with-filename word-regexp xz'),
    negatedBools: false,
    // BSD grep: --context[=num] (optional); GNU grep: --context=NUM (required)
    ambiguous: words('context'),
    digitsAreContext: true,
    honorsPosix: true,
    stripShortEquals: false,
    roles: {
      e: 'pattern', regexp: 'pattern',
      f: 'patternFile', file: 'patternFile',
      include: 'include',
      l: 'listing', L: 'listing', c: 'listing', q: 'listing',
      'files-with-matches': 'listing', 'files-without-match': 'listing',
      count: 'listing', quiet: 'listing', silent: 'listing',
    },
  },
  rg: {
    shortValue: 'ABCEMTdefgjmrt',
    shortOptionalNumber: '',
    shortBool: '.0FHILNPSUVabchilnopqsuvwxz',
    longValue: words('after-context before-context color colors context context-separator dfa-size-limit encoding engine field-context-separator field-match-separator file generate glob hostname-bin hyperlink-format iglob ignore-file max-columns max-count max-depth max-filesize path-separator pre pre-glob regex-size-limit regexp replace sort sortr threads type type-add type-clear type-not'),
    longEqualsOnly: new Set(),
    longOptionalNumber: new Set(),
    longBool: words('auto-hybrid-regex binary block-buffered byte-offset case-sensitive column count count-matches crlf debug files files-with-matches files-without-match fixed-strings follow glob-case-insensitive heading help hidden ignore-case ignore-file-case-insensitive include-zero invert-match json line-buffered line-number line-regexp max-columns-preview mmap multiline multiline-dotall no-config no-filename no-ignore no-ignore-dot no-ignore-exclude no-ignore-files no-ignore-global no-ignore-messages no-ignore-parent no-ignore-vcs no-line-number no-messages no-pcre2-unicode no-require-git no-unicode null null-data one-file-system only-matching passthru pcre2 pcre2-version pretty quiet search-zip smart-case sort-files stats stop-on-nonmatch text trace trim type-list unrestricted version vimgrep with-filename word-regexp'),
    // every --no-X flag rg accepts is a boolean
    negatedBools: true,
    ambiguous: new Set(),
    digitsAreContext: false,
    // rg's parser reads options anywhere before `--`, POSIXLY_CORRECT or not
    honorsPosix: false,
    // rg (clap) reads -g=X as -g X
    stripShortEquals: true,
    roles: {
      e: 'pattern', regexp: 'pattern',
      f: 'patternFile', file: 'patternFile',
      g: 'include', glob: 'include', iglob: 'include',
      l: 'listing', c: 'listing', q: 'listing',
      'files-with-matches': 'listing', 'files-without-match': 'listing',
      count: 'listing', 'count-matches': 'listing', quiet: 'listing',
      files: 'noSearch', 'type-list': 'noSearch',
    },
  },
  ag: {
    shortValue: 'GgmpW',
    // -A/-B/-C: ag puts a value that is not a number back as the pattern
    shortOptionalNumber: 'ABC',
    shortBool: '0DFHLQRSUVacfhilnorstuvwz',
    longValue: words('ackmate-dir-filter color-line-number color-match color-path depth file-search-regex filename-pattern ignore ignore-dir max-count pager path-to-ignore width workers'),
    longEqualsOnly: words('after before context'),
    longOptionalNumber: new Set(),
    longBool: words('ackmate affinity all-text all-types break case-sensitive color color-win-ansi column count debug filename files-with-matches files-without-matches fixed-strings follow group heading help hidden ignore-case invert-match line-numbers list-file-types literal match mmap multiline no-affinity no-break no-color no-filename no-follow no-group no-heading no-mmap no-multiline no-numbers no-pager no-recurse noaffinity nobreak nocolor nofilename nofollow nogroup noheading nommap nomultiline nonumbers nopager norecurse null numbers one-device only-matching parallel passthrough passthru print-all-files print-long-lines print0 recurse search-binary search-files search-zip silent skip-vcs-ignores smart-case stats stats-only unrestricted version vimgrep word-regexp'),
    negatedBools: false,
    ambiguous: new Set(),
    digitsAreContext: false,
    honorsPosix: true,
    stripShortEquals: false,
    roles: {
      // -g PATTERN prints file names matching PATTERN; nothing is searched
      g: 'noSearch', 'filename-pattern': 'noSearch', 'list-file-types': 'noSearch',
      l: 'listing', L: 'listing', c: 'listing',
      'files-with-matches': 'listing', 'files-without-matches': 'listing', count: 'listing',
    },
  },
  ack: {
    shortValue: 'gmtT',
    shortOptionalNumber: 'ABCp',
    shortBool: '1cfHhIikLlnoPQRrSsvwx',
    longValue: words('ackrc and color-colno color-filename color-lineno color-match files-from ignore-dir ignore-directory ignore-file match max-count noignore-dir noignore-directory not or output range-end range-start type type-add type-del type-set'),
    longEqualsOnly: new Set(),
    longOptionalNumber: words('after-context before-context context proximate'),
    longBool: words('bar break cathy color colour column count create-ackrc dump env files-with-matches files-without-matches filter flush follow group heading help help-colors help-rgb-colors help-types ignore-ack-defaults ignore-case invert-match known-types literal man no-filename no-ignore-case no-recurse no-smart-case nobreak nocolor nocolour nocolumn noenv nofilter nofollow nogroup noheading nopager nosmart-case nounderline passthru print0 recurse show-types smart-case sort-files thpppt underline version with-filename word-regexp'),
    negatedBools: false,
    // --pager takes an optional string; whether the next word is it depends on Getopt::Long
    ambiguous: words('pager'),
    digitsAreContext: false,
    honorsPosix: true,
    stripShortEquals: false,
    roles: {
      match: 'pattern', and: 'pattern', or: 'pattern', not: 'pattern',
      // -f lists the files it would search; -g lists file names matching a pattern
      f: 'noSearch', g: 'noSearch',
      l: 'listing', L: 'listing', c: 'listing',
      'files-with-matches': 'listing', 'files-without-matches': 'listing', count: 'listing',
    },
  },
};

const TOOL_NAMES = {
  grep: 'grep', egrep: 'grep', fgrep: 'grep', ggrep: 'grep',
  rg: 'rg', ag: 'ag', ack: 'ack', 'ack-grep': 'ack',
};

const SHELLS = words('sh bash zsh dash ksh');

// Words that start a command without being it: `{ grep ...; }`, `if grep`, `time grep`.
const KEYWORDS = words('{ } ! if then else elif fi do done while until time');

// Wrappers that run the command after their own options, with the options
// that take a separate value. `positionals`: words before the command
// (timeout's duration). `extraOperands`: the command gets more operands at
// run time.
const WRAPPERS = {
  command: { short: '', long: [] },
  builtin: { short: '', long: [] },
  nohup: { short: '', long: [] },
  exec: { short: 'a', long: [] },
  nice: { short: 'n', long: ['adjustment'] },
  stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] },
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'] },
  sudo: { short: 'ugCDhpRrTt', long: ['user', 'group', 'chdir', 'close-from', 'host', 'prompt', 'role', 'type', 'other-user', 'command-timeout'] },
  doas: { short: 'uC', long: [] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'], positionals: 1 },
  xargs: { short: 'IaLnPsdE', long: ['arg-file', 'delimiter', 'max-args', 'max-lines', 'max-procs', 'max-chars', 'process-slot-var'], extraOperands: true },
};

// A mention of a grep-family name anywhere in the text.
const MENTION = /\b(?:[efg]?grep|rg|ag|ack(?:-grep)?)\b/gi;

function isInteger(word) {
  return Boolean(word) && !word.dynamic && /^-?\d+$/.test(word.text);
}

function commandName(word) {
  if (!word || word.dynamic) return '';
  return word.text.split(/[\\/]/).pop().toLowerCase();
}

/**
 * Parse a shell command. Returns
 *   { invocations: [Invocation], unaccounted: [number] }
 * where `unaccounted` holds the index of every mention of a grep-family name
 * that no parsed invocation covers, an Invocation is
 *   { tool, patterns: [string], operands: [Word], includes: [string|null],
 *     listing, noSearch, conservative, extraOperands, words: [Word] }
 * and a Word is { text, dynamic, splittable, start, end } (dynamic: holds an
 * expansion whose value is unknown; splittable: an unquoted one, which the
 * shell may split into several words; start/end: its span in the input).
 */
function parseCommand(src) {
  const text = String(src ?? '');
  const out = {
    input: text,
    invocations: [],
    spans: [],
    exact: true,
    // Once POSIXLY_CORRECT is set anywhere (export, env, a prefix), grep,
    // ag and ack stop reading options at the first operand.
    posix: /POSIXLY_CORRECT/.test(text),
  };
  scan(text, 0, out, 0);
  // Mentions come in order; sweep the spans sorted by start, tracking the
  // furthest end of any span begun so far, so the check stays linear.
  const spans = out.spans.sort((x, y) => x[0] - y[0]);
  const unaccounted = [];
  let j = 0;
  let reach = -1;
  for (const m of text.matchAll(MENTION)) {
    while (j < spans.length && spans[j][0] <= m.index) reach = Math.max(reach, spans[j++][1]);
    if (m.index >= reach) unaccounted.push(m.index);
  }
  return { invocations: out.invocations, unaccounted };
}

// Mark the literal words of a command as accounted for. A dynamic word's
// substitutions are scanned on their own and account for themselves. Spans
// are only trusted where the scanned text is the input itself at that offset
// (see scan); elsewhere the mentions stay unaccounted.
function account(out, cmdWords) {
  if (!out.exact) return;
  for (const w of cmdWords) if (!w.dynamic) out.spans.push([w.start, w.end]);
}

// `base` is the offset of src in the original input. Text that went through
// unquoting or unescaping (sh -c, eval, backticks) no longer lines up with
// the input, so word spans inside it cannot be trusted to point at the right
// characters.
function scan(src, depth, out, base) {
  if (depth > MAX_DEPTH) return;
  const outer = out.exact;
  out.exact = outer && out.input.startsWith(src, base);
  const commands = splitCommands(src, depth, out, base);
  if (commands !== null) {
    for (const cmd of commands) findInvocation(cmd, depth, out, false);
  }
  out.exact = outer;
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

// Split src into simple commands, each a list of Words. Substitutions and
// heredoc bodies are scanned recursively into `out` as they are met.
// Returns null when src cannot be tokenized.
function splitCommands(src, depth, out, base) {
  const commands = [];
  let cmd = [];
  let word = null;
  let dropNextWord = false;
  const heredocs = [];
  let i = 0;

  const cur = () => (word ??= {
    text: '', dynamic: false, splittable: false,
    start: base + i, end: base + i, quoted: src[i] === "'" || src[i] === '"',
  });
  const endWord = () => {
    if (word === null) return;
    word.end = base + i;
    if (dropNextWord) dropNextWord = false;
    else cmd.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (cmd.length) commands.push(cmd);
    cmd = [];
    dropNextWord = false;
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] !== '\n') cur().text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return null;
      cur().text += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = readDoubleQuoted(src, i + 1, cur(), depth, out, base);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (c === '$' || c === '`') {
      const end = readExpansion(src, i, cur(), depth, out, base, false);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (c === '#' && word === null) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '\n') {
      endCommand();
      i++;
      if (heredocs.length) i = readHeredocBodies(src, i, heredocs.splice(0), depth, out, base);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '&' && src[i + 1] === '>') {
      endWord();
      i += src[i + 2] === '>' ? 3 : 2;
      dropNextWord = true;
      continue;
    }
    if (c === '|' || c === ';' || c === '&' || c === '(' || c === ')') {
      endCommand();
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      if (src[i + 1] === '(') {
        const end = findClosing(src, i + 1, '(', ')');
        if (end < 0) return null;
        scan(src.slice(i + 2, end), depth + 1, out, base + i + 2);
        const w = cur();
        // One /dev/fd path: dynamic, but never split.
        w.text += `${c}(...)`;
        w.dynamic = true;
        i = end + 1;
        continue;
      }
      // An all-digit word right before a redirection is its fd number.
      if (word !== null && !word.dynamic && /^\d+$/.test(word.text)) word = null;
      else endWord();
      if (src.startsWith('<<<', i)) {
        i += 3;
        dropNextWord = true;
        continue;
      }
      if (src.startsWith('<<', i)) {
        i += 2;
        const stripTabs = src[i] === '-';
        if (stripTabs) i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        const delim = readHeredocDelimiter(src, i);
        if (delim === null) return null;
        heredocs.push({ delim: delim.text, stripTabs });
        i = delim.end;
        continue;
      }
      i++;
      while (src[i] === '>' || src[i] === '&' || src[i] === '|') i++;
      dropNextWord = true;
      continue;
    }
    cur().text += c;
    i++;
  }
  endCommand();
  if (heredocs.length) return null;
  return commands;
}

function readDoubleQuoted(src, start, w, depth, out, base) {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return i;
    if (c === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
      if (src[i + 1] !== '\n') w.text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '$' || c === '`') {
      const end = readExpansion(src, i, w, depth, out, base, true);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    w.text += c;
    i++;
  }
  return -1;
}

// Read a $-expansion or backtick substitution starting at src[i] into w.
// Anything inside that can hold a command ($(...), backticks, $((...)),
// ${...}) is scanned recursively. Returns the index after it, or -1 if it
// never closes.
function readExpansion(src, i, w, depth, out, base, quoted) {
  const markDynamic = () => {
    w.dynamic = true;
    if (!quoted) w.splittable = true;
  };
  if (src[i] === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) return -1;
    scan(src.slice(i + 1, j).replace(/\\([`\\$])/g, '$1'), depth + 1, out, base + i + 1);
    markDynamic();
    w.text += '`...`';
    return j + 1;
  }
  const n = src[i + 1];
  if (n === '(') {
    const end = findClosing(src, i + 1, '(', ')');
    if (end < 0) return -1;
    // $((...)) is arithmetic, but may hold a $(...) of its own.
    const inner = src[i + 2] === '(' ? i + 3 : i + 2;
    scan(src.slice(inner, end), depth + 1, out, base + inner);
    markDynamic();
    w.text += '$(...)';
    return end + 1;
  }
  if (n === '{') {
    const end = findClosing(src, i + 1, '{', '}');
    if (end < 0) return -1;
    // ${x:-$(cmd)}: the default may run a command.
    scan(src.slice(i + 2, end), depth + 1, out, base + i + 2);
    markDynamic();
    w.text += src.slice(i, end + 1);
    return end + 1;
  }
  if (n === "'" && !quoted) {
    // $'...' (ANSI-C quoting): a literal string with backslash escapes.
    let j = i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) return -1;
    w.text += src.slice(i + 2, j);
    return j + 1;
  }
  if (n !== undefined && /[A-Za-z_]/.test(n)) {
    let j = i + 2;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
    markDynamic();
    w.text += src.slice(i, j);
    return j;
  }
  if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
    markDynamic();
    w.text += src.slice(i, i + 2);
    return i + 2;
  }
  w.text += '$';
  return i + 1;
}

// Index of the bracket closing the one at src[open], skipping quotes and
// escapes; -1 if it never closes.
function findClosing(src, open, openCh, closeCh) {
  let level = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return -1;
      i = j;
    } else if (c === openCh) {
      level++;
    } else if (c === closeCh) {
      level--;
      if (level === 0) return i;
    }
  }
  return -1;
}

function readHeredocDelimiter(src, i) {
  let text = '';
  while (i < src.length && !/[\s;|&<>()]/.test(src[i])) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return null;
      text += src.slice(i + 1, end);
      i = end + 1;
    } else {
      if (c !== '\\') text += c;
      i++;
    }
  }
  return text ? { text, end: i } : null;
}

// Heredoc bodies start on the line after the redirection. Each body is
// scanned as shell: a heredoc fed to `bash` or `sh` runs, and one fed
// elsewhere is checked the same way rather than guessed about.
function readHeredocBodies(src, i, pending, depth, out, base) {
  for (const { delim, stripTabs } of pending) {
    const bodyStart = i;
    let bodyEnd = src.length;
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      const line = src.slice(i, end);
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) {
        bodyEnd = Math.max(bodyStart, i - 1);
        i = nl < 0 ? src.length : nl + 1;
        break;
      }
      i = nl < 0 ? src.length : nl + 1;
    }
    scan(src.slice(bodyStart, bodyEnd), depth + 1, out, base + bodyStart);
  }
  return i;
}

// ── Commands ───────────────────────────────────────────────────────────────

// Index after a wrapper's own options (and leading positionals), so that
// cmd[i] is the command it runs.
function skipWrapperOptions(cmd, i, spec) {
  while (cmd[i] && cmd[i].text.startsWith('-') && !cmd[i].dynamic) {
    const t = cmd[i].text;
    if (t === '--') return i + 1 + (spec.positionals ?? 0);
    if (t.startsWith('--')) {
      i += !t.includes('=') && spec.long.includes(t.slice(2)) ? 2 : 1;
    } else {
      // A value-taking letter ends the cluster; its value is attached or next.
      const k = [...t.slice(1)].findIndex(ch => spec.short.includes(ch));
      i += k >= 0 && k === t.length - 2 ? 2 : 1;
    }
  }
  return i + (spec.positionals ?? 0);
}

// Find the command a word list runs, past assignments, keywords and wrappers,
// and record it if it is a grep-family tool. `extraOperands`: the command
// gets more operands at run time (xargs, find -exec).
function findInvocation(cmd, depth, out, extraOperands) {
  let i = 0;
  let posix = out.posix;
  while (i < cmd.length) {
    const w = cmd[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) {
      if (w.text.startsWith('POSIXLY_CORRECT=')) posix = true;
      i++;
      continue;
    }
    if (KEYWORDS.has(w.text) && !w.dynamic) {
      i++;
      while (cmd[i] && cmd[i].text.startsWith('-') && !cmd[i].dynamic) i++;
      continue;
    }
    const spec = WRAPPERS[commandName(w)];
    if (!spec) break;
    if (spec.extraOperands) extraOperands = true;
    i = skipWrapperOptions(cmd, i + 1, spec);
  }

  const rest = cmd.slice(i);
  if (rest.length === 0) return;
  const name = commandName(rest[0]);

  if (TOOL_NAMES[name]) {
    account(out, rest);
    out.invocations.push(parseArgs(TOOL_NAMES[name], rest.slice(1), posix, extraOperands));
    return;
  }
  if (name === 'git' && gitSubcommand(rest) === 'grep') {
    // git grep searches history; the guard never gated it. Only the grep
    // subcommand: `git bisect run grep ...` runs a real grep.
    account(out, rest);
    return;
  }
  if (SHELLS.has(name)) {
    const flag = rest.findIndex((w, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
    let script = flag > 0 ? flag + 1 : -1;
    if (script > 0 && rest[script]?.text === '--') script++;
    const w = rest[script];
    if (w && !w.dynamic) scan(w.text, depth + 1, out, w.start + (w.quoted ? 1 : 0));
    return;
  }
  if (name === 'eval' && rest[1]) {
    scan(rest.slice(1).map(x => x.text).join(' '), depth + 1, out, rest[1].start);
    return;
  }
  if (name === 'find') {
    for (let k = 1; k < rest.length; k++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(rest[k].text)) continue;
      const end = rest.findIndex((x, m) => m > k && (x.text === ';' || x.text === '+'));
      findInvocation(rest.slice(k + 1, end < 0 ? rest.length : end), depth, out, true);
      k = end < 0 ? rest.length : end;
    }
  }
}

// git's own options before the subcommand; these take a separate value.
const GIT_VALUE_OPTIONS = words('-C -c --git-dir --work-tree --namespace --super-prefix --config-env --exec-path');

function gitSubcommand(rest) {
  let i = 1;
  while (rest[i] && rest[i].text.startsWith('-') && !rest[i].dynamic) {
    i += GIT_VALUE_OPTIONS.has(rest[i].text) ? 2 : 1;
  }
  return rest[i] && !rest[i].dynamic ? rest[i].text : '';
}

// ── Arguments ──────────────────────────────────────────────────────────────

function parseArgs(tool, args, posix, extraOperands) {
  const spec = TOOLS[tool];
  const inv = {
    tool,
    patterns: [],
    operands: [],
    includes: [],
    listing: false,
    noSearch: false,
    conservative: false,
    extraOperands,
    words: args,
  };
  let explicitPattern = false;
  const positionals = [];
  let optionsDone = false;

  const apply = (key, value, valueWord) => {
    const role = spec.roles[key];
    if (role === 'listing') inv.listing = true;
    else if (role === 'noSearch') inv.noSearch = true;
    else if (role === 'pattern') {
      inv.patterns.push(value);
      explicitPattern = true;
    } else if (role === 'patternFile') {
      explicitPattern = true;
    } else if (role === 'include') {
      if (valueWord?.dynamic) inv.includes.push(null);
      else if (!value.startsWith('!')) inv.includes.push(value);
    }
  };

  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const t = w.text;

    if (!optionsDone && w.splittable) {
      // An unquoted expansion may split into options. Before the pattern is
      // known, one could shift which word is the pattern: unknowable. After
      // it, it is an operand of unknown value (it cannot undo -l, -c or -q).
      if (positionals.length === 0 && !explicitPattern) inv.conservative = true;
      positionals.push(w);
      continue;
    }
    if (optionsDone || w.dynamic || t === '-' || !t.startsWith('-')) {
      positionals.push(w);
      if (posix && spec.honorsPosix) optionsDone = true;
      continue;
    }
    if (t === '--') {
      optionsDone = true;
      continue;
    }

    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      let value = eq < 0 ? undefined : t.slice(eq + 1);
      let valueWord = null;
      if (spec.ambiguous.has(name) && value === undefined) {
        inv.conservative = true;
      } else if (spec.longValue.has(name)) {
        if (value === undefined) {
          valueWord = args[++i];
          if (!valueWord) {
            inv.conservative = true;
            continue;
          }
          value = valueWord.text;
        }
        apply(name, value, valueWord);
      } else if (spec.longEqualsOnly.has(name)) {
        // value only ever arrives as --opt=X
      } else if (spec.longOptionalNumber.has(name)) {
        if (value === undefined && isInteger(args[i + 1])) i++;
      } else if (spec.longBool.has(name) || (spec.negatedBools && name.startsWith('no-'))) {
        if (value !== undefined) inv.conservative = true;
        apply(name);
      } else {
        inv.conservative = true;
      }
      continue;
    }

    const cluster = t.slice(1);
    if (spec.digitsAreContext && /^\d+$/.test(cluster)) continue;
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k];
      if (spec.shortValue.includes(ch)) {
        let value = cluster.slice(k + 1);
        let valueWord = null;
        if (value === '') {
          valueWord = args[++i];
          if (!valueWord) {
            inv.conservative = true;
            break;
          }
          value = valueWord.text;
        } else if (spec.stripShortEquals && value.startsWith('=')) {
          value = value.slice(1);
        }
        apply(ch, value, valueWord);
        break;
      }
      if (spec.shortOptionalNumber.includes(ch)) {
        const attached = cluster.slice(k + 1);
        if (attached === '' && isInteger(args[i + 1])) i++;
        else if (attached !== '' && !/^\d+$/.test(attached)) inv.conservative = true;
        break;
      }
      if (spec.shortBool.includes(ch)) {
        apply(ch);
        continue;
      }
      inv.conservative = true;
      break;
    }
  }

  // The first positional is the pattern unless one came from -e/-f or the
  // invocation searches nothing; the rest are the files and directories.
  if (explicitPattern || inv.noSearch) {
    inv.operands = positionals;
  } else if (positionals.length) {
    inv.patterns.push(positionals[0].text);
    inv.operands = positionals.slice(1);
  }
  return inv;
}

module.exports = { parseCommand, TOOLS };

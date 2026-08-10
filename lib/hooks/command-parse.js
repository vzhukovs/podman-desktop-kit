/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// Turning a raw Bash command string into the list of commands that will
// actually run.
//
// This is the load-bearing module of the whole safety story, because the
// PreToolUse matcher only ever sees the tool name "Bash" — never the command.
// Every deny decision is made from what this function returns.
//
// What it must survive:
//
//   FOO=bar git push                leading assignments
//   npm test && git push            operators: && || ; | & newline
//   echo $(git push)                substitutions: $() and backticks
//   sudo git push / env git push    wrapper programs
//   git   push                      whitespace
//   'git' push / "git" push         quoted argv[0]
//   (git push)                      subshells
//   /usr/bin/git push               a program named by path
//
// A miss here is not a cosmetic bug: it is a push to someone else's repository
// with no gate and no confirmation, and no error message anywhere. Hence
// test/command-parse.test.js, and hence the wrapper handling lives here rather
// than in a list of patterns that has to be guessed ahead of time.
//
// The parser errs towards seeing MORE commands than bash would run. Reporting a
// command inside a substitution that never executes costs one refusal the user
// can work around; missing one costs an unreviewed push. Only one of those two
// errors is recoverable.

/**
 * Programs that wrap and re-exec another command; strip them and re-examine.
 *
 * The list is deliberately of *programs*, not of intentions. A wrapper does not
 * have to be typed by anyone: a hook installed for an unrelated project can
 * rewrite commands in this one, since hooks on the Bash tool are global. So the
 * question this module answers is never "did somebody mean to wrap it" but
 * "what is going to run", and `sudo git push` has to reach the gate as a push.
 */
export const WRAPPERS = ['command', 'env', 'nice', 'time', 'sudo', 'nohup', 'xargs'];

/** How deep to follow nested substitutions before giving up. */
const MAX_SUBSTITUTION_DEPTH = 8;

/** `FOO=bar` in the leading position is an assignment, not a program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Characters that end a command outside quotes.
 *
 * Parentheses are in the list because `(git push)` is a subshell: without them
 * the program would parse as "(git" and match no rule at all.
 */
const SEPARATORS = '\n;&|()';

/**
 * @typedef {object} ParsedCommand
 * @property {string} program        argv[0] after unquoting and unwrapping
 * @property {string[]} args
 * @property {string} raw            the segment as written
 * @property {string[]} wrappers     wrappers stripped, outermost first
 */

/**
 * @typedef {object} Token
 * @property {string} text
 * @property {boolean} quoted   any part of it came from inside quotes
 */

/**
 * Last path component. `/usr/bin/git push` has to match the same rules as
 * `git push`; comparing the token as written would let a full path through.
 *
 * @param {string} value
 * @returns {string}
 */
function basename(value) {
  const cut = value.lastIndexOf('/');
  return cut === -1 ? value : value.slice(cut + 1);
}

/**
 * Skip past a `$(...)` substitution, recording what is inside it.
 *
 * @param {string} line
 * @param {number} at     index of the `$`
 * @param {string[]} nested
 * @returns {number} index just past the closing parenthesis
 */
function captureParenthesis(line, at, nested) {
  let depth = 0;
  let i = at + 1;

  for (; i < line.length; i += 1) {
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  // `$(( ... ))` is arithmetic, not a command. Descending into it would produce
  // noise like a program named "1+2".
  if (line[at + 2] !== '(') nested.push(line.slice(at + 2, i));

  return i + 1;
}

/**
 * Skip past a backtick substitution, recording what is inside it.
 *
 * @param {string} line
 * @param {number} at     index of the opening backtick
 * @param {string[]} nested
 * @returns {number} index just past the closing backtick
 */
function captureBacktick(line, at, nested) {
  const close = line.indexOf('`', at + 1);
  const end = close === -1 ? line.length : close;
  nested.push(line.slice(at + 1, end));
  return end + 1;
}

/**
 * Split a line into segments of tokens, collecting substitutions to be parsed
 * separately.
 *
 * Quoting is tracked rather than stripped by regex, because the difference
 * between `git push` and `git commit -m "git push"` is exactly the difference
 * between a command and a string that mentions one.
 *
 * @param {string} line
 * @returns {{segments: Array<{raw: string, tokens: Token[]}>, nested: string[]}}
 */
function scan(line) {
  /** @type {Array<{raw: string, tokens: Token[]}>} */
  const segments = [];
  /** @type {string[]} */
  const nested = [];
  /** @type {Token[]} */
  let tokens = [];
  /** @type {Token|null} */
  let current = null;
  let start = 0;
  let i = 0;

  const put = (text, quoted) => {
    if (current === null) current = { text: '', quoted: false };
    current.text += text;
    if (quoted) current.quoted = true;
  };

  const endToken = () => {
    if (current !== null) {
      tokens.push(current);
      current = null;
    }
  };

  const endSegment = (end) => {
    endToken();
    // `{` and `}` are grouping, not programs. Quoted braces are arguments and
    // stay.
    const kept = tokens.filter((token) => token.quoted || (token.text !== '{' && token.text !== '}'));
    if (kept.length > 0) segments.push({ raw: line.slice(start, end).trim(), tokens: kept });
    tokens = [];
  };

  while (i < line.length) {
    const ch = line[i];

    if (ch === '\\' && i + 1 < line.length) {
      put(line[i + 1], true);
      i += 2;
      continue;
    }

    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close === -1 ? line.length : close;
      put(line.slice(i + 1, end), true);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      i += 1;
      put('', true);
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          put(line[i + 1], true);
          i += 2;
        } else if (line[i] === '$' && line[i + 1] === '(') {
          // Substitution runs inside double quotes too.
          i = captureParenthesis(line, i, nested);
        } else if (line[i] === '`') {
          i = captureBacktick(line, i, nested);
        } else {
          put(line[i], true);
          i += 1;
        }
      }
      i += 1;
      continue;
    }

    if (ch === '$' && line[i + 1] === '(') {
      i = captureParenthesis(line, i, nested);
      continue;
    }

    if (ch === '`') {
      i = captureBacktick(line, i, nested);
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      endToken();
      i += 1;
      continue;
    }

    if (SEPARATORS.includes(ch)) {
      endSegment(i);
      while (i < line.length && (SEPARATORS.includes(line[i]) || line[i] === ' ' || line[i] === '\t')) {
        i += 1;
      }
      start = i;
      continue;
    }

    put(ch, false);
    i += 1;
  }

  endSegment(line.length);

  return { segments, nested };
}

/**
 * Turn one segment's tokens into the commands it could execute, resolving
 * assignments and wrappers.
 *
 * Returns more than one entry only when a wrapper was stripped. The reason is
 * that a wrapper's options are its own grammar: `sudo -u someone git push`
 * hides the program two tokens further along than `nice -n10 git push` does,
 * and there is no way to know that without a table of every option of every
 * wrapper — a table that goes stale silently, and whose staleness shows up as
 * a push that was never gated.
 *
 * So once a wrapper is in play, every following bare token is treated as a
 * possible program. The cost is a few phantom commands nobody runs; since the
 * rules all require an argument prefix, phantoms match nothing in practice.
 * The alternative cost is missing the real one.
 *
 * @param {string} raw
 * @param {Token[]} tokens
 * @returns {ParsedCommand[]}
 */
function toCommands(raw, tokens) {
  const rest = tokens.slice();
  /** @type {string[]} */
  const wrappers = [];

  const stripAssignments = () => {
    while (rest.length > 0 && !rest[0].quoted && ASSIGNMENT.test(rest[0].text)) rest.shift();
  };

  const at = (index) => ({
    program: basename(rest[index].text),
    args: rest.slice(index + 1).map((token) => token.text),
    raw,
    wrappers,
  });

  stripAssignments();

  for (let guard = 0; guard < WRAPPERS.length + 1 && rest.length > 0; guard += 1) {
    const name = basename(rest[0].text);
    if (!WRAPPERS.includes(name)) break;

    wrappers.push(name);
    rest.shift();
    // `env FOO=1 nice sudo git push`: a wrapper may be followed by its own
    // assignments and its own options before the real program appears.
    stripAssignments();
    while (rest.length > 0 && !rest[0].quoted && rest[0].text.startsWith('-')) rest.shift();
  }

  if (rest.length === 0) return [];

  const commands = [at(0)];
  if (wrappers.length > 0) {
    for (let index = 1; index < rest.length; index += 1) {
      // A quoted token is data, and an option is not a program.
      if (rest[index].quoted || rest[index].text.startsWith('-')) continue;
      commands.push(at(index));
    }
  }

  return commands;
}

/**
 * Decompose a command line into every command it will execute.
 *
 * Returns a flat list: operators, substitutions, and wrappers are resolved, so
 * the caller matches against `program` and `args` and nothing else.
 *
 * @param {string} commandLine
 * @param {number} [depth]  internal; bounds substitution recursion
 * @returns {ParsedCommand[]}
 */
export function parse(commandLine, depth = 0) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return [];

  const { segments, nested } = scan(commandLine);
  /** @type {ParsedCommand[]} */
  const commands = [];

  for (const segment of segments) {
    commands.push(...toCommands(segment.raw, segment.tokens));
  }

  if (depth < MAX_SUBSTITUTION_DEPTH) {
    for (const inner of nested) commands.push(...parse(inner, depth + 1));
  }

  return commands;
}

/**
 * Whether any command in the line matches a program and argument prefix.
 *
 * @param {string} commandLine
 * @param {string} program            e.g. "git"
 * @param {string[]} [argPrefix]      e.g. ["push"]
 * @returns {boolean}
 */
export function matches(commandLine, program, argPrefix = []) {
  return parse(commandLine).some(
    (command) =>
      command.program === program && argPrefix.every((value, index) => command.args[index] === value),
  );
}

/**
 * Whether a flag is present on a parsed command, in either --flag or
 * --flag=value form.
 *
 * Exact, never by prefix: `--force-with-lease` starts with `--force`, and
 * reading a leased push as a forced one would invert the one rule that is
 * refused unconditionally.
 *
 * @param {ParsedCommand} command
 * @param {string} flag
 * @returns {boolean}
 */
export function hasFlag(command, flag) {
  return (command?.args ?? []).some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Value of an option written either `-X POST` or `--method=POST`.
 *
 * @param {ParsedCommand} command
 * @param {string[]} names     every spelling of the same option
 * @returns {string|null}
 */
export function optionValue(command, names) {
  const args = command?.args ?? [];

  for (let i = 0; i < args.length; i += 1) {
    if (names.includes(args[i])) return args[i + 1] ?? null;

    const separator = args[i].indexOf('=');
    if (separator !== -1 && names.includes(args[i].slice(0, separator))) {
      return args[i].slice(separator + 1);
    }
  }

  return null;
}

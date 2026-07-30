// SPDX-License-Identifier: Apache-2.0

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
//   rtk git push                    wrapper programs (see spec 8.2)
//   git   push                      whitespace
//   'git' push / "git" push         quoted argv[0]
//
// A miss here is not a cosmetic bug: it is a push to someone else's repository
// with no gate and no confirmation, and no error message anywhere. Hence
// test/command-parse.test.js, and hence the wrapper handling lives here rather
// than in a list of patterns that has to be guessed ahead of time.

/** Programs that wrap and re-exec another command; strip them and re-examine. */
export const WRAPPERS = ['rtk', 'command', 'env', 'nice', 'time', 'sudo', 'nohup', 'xargs'];

/**
 * @typedef {object} ParsedCommand
 * @property {string} program        argv[0] after unquoting and unwrapping
 * @property {string[]} args
 * @property {string} raw            the segment as written
 * @property {string[]} wrappers     wrappers stripped, outermost first
 */

/**
 * Decompose a command line into every command it will execute.
 *
 * Returns a flat list: operators, substitutions, and wrappers are resolved, so
 * the caller matches against `program` and `args` and nothing else.
 *
 * @param {string} _commandLine
 * @returns {ParsedCommand[]}
 */
export function parse(_commandLine) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Whether any command in the line matches a program and argument prefix.
 *
 * @param {string} _commandLine
 * @param {string} _program            e.g. "git"
 * @param {string[]} [_argPrefix]      e.g. ["push"]
 * @returns {boolean}
 */
export function matches(_commandLine, _program, _argPrefix) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Whether a flag is present on a parsed command, in either --flag or
 * --flag=value form.
 *
 * @param {ParsedCommand} _command
 * @param {string} _flag
 * @returns {boolean}
 */
export function hasFlag(_command, _flag) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

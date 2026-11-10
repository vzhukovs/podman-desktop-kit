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

// PostToolUse handler for Bash: a read that stopped inside a block.
//
// `grep -A60`, `sed -n a,bp` and `head -N` cut their output without saying so,
// and what they cut reads as complete. When the cut lands inside a namespace,
// a class or an object literal, the members past it are unread, and the ones
// most often past it are the newest, because new members are appended at the
// end. A model asking "does this API already have X?" then reads "no" off a
// window that stopped short of X.
//
// A rule in a prompt did not hold this: the skills that carry rules are not
// running when ad-hoc analysis happens, and a hook is. So the rule rides on
// the output that breaks it, every time, and only then.
//
// Two facts, both cheap: the command contains a windowing operator, and the
// output ends with more `{` opened than closed. Either alone is noise — most
// windowed reads end cleanly, and most open braces come from reads that were
// not cut. Together they are what a cut-off block looks like.
//
// What it cannot see: output from several reads in one command is merged, so
// one read's unclosed block can be balanced by another's stray `}`. And braces
// inside strings count. It misses some cuts; it does not invent them.
//
// Not scoped to podman-desktop. The rule is true in any repository, and the
// reads that went wrong included a clone of a third-party reference project.

import { parse } from './command-parse.js';

/** Programs that search with optional context lines around a match. */
const GREPS = ['grep', 'egrep', 'fgrep', 'rg', 'ag'];

/** `-A60`, `-nA5`, `-C` — a short-option cluster ending in a context option. */
const CONTEXT_CLUSTER = /^-[a-zA-Z]*[ABC](\d*)$/;
const CONTEXT_LONG = /^--(after|before)?-?context(=\d+)?$/;
const SED_RANGE = /^\d+,\+?\d+p$/;
const AWK_RANGE = /NR\s*[<>]=?\s*\d+/;
const FOLLOW = ['-f', '-F', '--follow'];

/**
 * The windowing operator in one parsed command, written as a reader would
 * recognize it, or null.
 *
 * @param {import('./command-parse.js').ParsedCommand} command
 * @returns {string|null}
 */
function windowOf(command) {
  const { program } = command;
  const args = program === 'git' && command.args[0] === 'grep' ? command.args.slice(1) : command.args;

  if (program === 'head' || program === 'tail') {
    // Following a log is watching, not reading a block.
    if (program === 'tail' && args.some((arg) => FOLLOW.includes(arg))) return null;
    // Only when it reads a file itself. At the end of a pipe it mostly trims a
    // list of matching lines, and a matched `start() {` opens a brace without
    // anyone having read the block: counted, that was a quarter of all reads.
    // A cut that a context grep makes before the pipe is still found, on the grep.
    const operands = args.filter((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-n');
    if (operands.length === 0) return null;
    const count = args.find((arg) => /^-n?\d+$/.test(arg) || /^--lines=\d+$/.test(arg));
    const spelled = count ?? (args[0] === '-n' && args[1] ? `-n ${args[1]}` : null);
    return spelled ? `${program} ${spelled}` : program;
  }

  if (GREPS.includes(program) || (program === 'git' && command.args[0] === 'grep')) {
    const name = program === 'git' ? 'git grep' : program;
    for (let i = 0; i < args.length; i += 1) {
      const cluster = CONTEXT_CLUSTER.exec(args[i]);
      if (cluster) return `${name} ${args[i]}${cluster[1] ? '' : ` ${args[i + 1] ?? ''}`.trimEnd()}`;
      if (CONTEXT_LONG.test(args[i])) return `${name} ${args[i]}`;
    }
    return null;
  }

  if (program === 'sed' && args.includes('-n')) {
    const range = args.find((arg) => SED_RANGE.test(arg));
    return range ? `sed -n ${range}` : null;
  }

  if (program === 'awk' || program === 'gawk') {
    const range = args.find((arg) => AWK_RANGE.test(arg));
    return range ? `awk '${range}'` : null;
  }

  return null;
}

/**
 * Every windowing operator in a command line, in order.
 *
 * @param {string} commandLine
 * @returns {string[]}
 */
export function windows(commandLine) {
  return parse(commandLine)
    .map(windowOf)
    .filter((window) => window !== null);
}

/**
 * How many `{` the text leaves open at its end.
 *
 * @param {string} text
 * @returns {{opened: number, closed: number}}
 */
export function braces(text) {
  let opened = 0;
  let closed = 0;
  for (const char of text) {
    if (char === '{') opened += 1;
    else if (char === '}') closed += 1;
  }
  return { opened, closed };
}

/**
 * The text of a Bash tool response. Claude Code sends an object with `stdout`;
 * a bare string is accepted so an older host is not misread as silence.
 *
 * @param {unknown} response
 * @returns {string}
 */
function outputOf(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && typeof response.stdout === 'string') return response.stdout;
  return '';
}

/**
 * Say so when a windowed read stopped inside a block.
 *
 * Never blocks: the command has already run, and what it printed is true as
 * far as it goes. What the model gets is the one sentence that stops it reading
 * the end of the window as the end of the block.
 *
 * @param {{tool_name?: string, tool_input?: {command?: string}, tool_response?: unknown}|null} payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, context) {
  if (payload?.tool_name && payload.tool_name !== 'Bash') return { block: false };

  const commandLine = payload?.tool_input?.command;
  if (!commandLine) return { block: false };

  const found = windows(commandLine);
  if (found.length === 0) return { block: false };

  const { opened, closed } = braces(outputOf(payload?.tool_response));
  if (opened <= closed) return { block: false };

  const rule = `${context?.pluginRoot ?? '${CLAUDE_PLUGIN_ROOT}'}/knowledge/pitfalls.md`;
  return {
    block: false,
    rule: 'cut-read',
    message:
      `pdkit: this output went through a window (${found.map((window) => `\`${window}\``).join(', ')}) ` +
      `and ends inside an open block: ${opened} \`{\` opened, ${closed} closed. ` +
      `What lies past the window is unread, not absent, and new members are usually appended at the end. ` +
      `Before stating that something does not exist, is not supported or is not handled, read each block ` +
      `you rely on to its closing brace: Read the file at that line, or widen the window until the brace ` +
      `appears, or search the whole file with no window. See "A window that ends inside a block" in ${rule}.`,
  };
}

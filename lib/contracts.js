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

// Which IPC channels a change touches: the contract no typecheck can see.
//
// The main process registers a handler under a string, `ipcHandle('x', …)`;
// preload calls it under the same string, `ipcInvoke('x', …)`, with arguments
// typed `unknown[]`. Change the handler's arguments on one side and not the
// other and every package still compiles. On DESKTOP-19818 the two sides went
// into two pull requests, each green on its own, and merging either one alone
// broke the image checker at runtime. Upstream found it with a screenshot.
//
// Facts, no verdict, like the rest of the slicer's inputs: this says which
// channels a file's changed lines belong to, and whether each channel existed
// before the change. Whether two slices may split a channel is build()'s call.
//
// A changed line belongs to a channel when it sits inside the call that
// registers or exposes it: from the anchor (`ipcHandle(`, `ipcMain.handle(`,
// `exposeInMainWorld(`) to the parenthesis that closes it. The handler's
// parameter list sits below the channel string in main, and the `ipcInvoke`
// sits below the changed parameters in preload, so neither a line-window
// nor the changed lines alone would find both.

/** Where a call that owns a channel starts. */
const ANCHOR = /\b(?:ipcHandle|ipcMain\.handle|ipcMain\.on|exposeInMainWorld)\s*\(/g;

/** A channel named as the first argument of a call that crosses the boundary. */
const CHANNEL = /\b(?:ipcHandle|ipcInvoke|ipcMain\.handle|ipcMain\.on|ipcRenderer\.invoke|ipcRenderer\.send|ipcRenderer\.on)\s*\(\s*(['"`])([^'"`$]+)\1/g;

/** Files worth reading at all. */
const CODE = /\.(?:[cm]?[jt]s|svelte)$/;

/**
 * Whether a path can hold an IPC registration.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function mayHoldChannels(path) {
  return CODE.test(path);
}

/**
 * Whether a text has anything this module would find, so a caller can skip
 * the diff for files that cannot.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasChannels(text) {
  // Through matchAll rather than CHANNEL.test: test() on a global expression
  // moves its lastIndex, and every matchAll after it starts from there. That
  // made the first file read after a match lose its channels.
  return channelsIn(text).size > 0;
}

/**
 * Every channel a text names, anywhere.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function channelsIn(text) {
  return new Set([...String(text ?? '').matchAll(CHANNEL)].map((match) => match[2]));
}

/**
 * The calls that own channels, as line ranges.
 *
 * Parentheses are counted outside strings and comments, which is enough for
 * the shape these calls have. A template literal with `${…}` inside is read as
 * one string, which can only make a block longer, never end one early.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, channels: string[]}>} 1-based, inclusive
 */
export function blocksOf(text) {
  const source = String(text ?? '');
  const lineAt = lineIndex(source);
  const blocks = [];

  for (const match of source.matchAll(ANCHOR)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(source, open);
    const body = source.slice(match.index, close + 1);

    blocks.push({
      start: lineAt(match.index),
      end: lineAt(close),
      channels: [...channelsIn(body)],
    });
  }

  return blocks.filter((block) => block.channels.length > 0);
}

/**
 * The offset of the parenthesis that closes the one at `open`, or the end of
 * the text when it never closes.
 *
 * @param {string} source
 * @param {number} open
 * @returns {number}
 */
function closingParen(source, open) {
  let depth = 0;
  let quote = null;

  for (let at = open; at < source.length; at += 1) {
    const char = source[at];

    if (quote) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && source[at + 1] === '/') {
      const end = source.indexOf('\n', at);
      at = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[at + 1] === '*') {
      const end = source.indexOf('*/', at + 2);
      at = end === -1 ? source.length : end + 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }

  return source.length - 1;
}

/**
 * A lookup from offset to 1-based line. Built once per text: main's
 * `index.ts` has hundreds of handlers, and a scan from the top for each one
 * is quadratic in a file of several thousand lines.
 *
 * @param {string} source
 * @returns {(offset: number) => number}
 */
function lineIndex(source) {
  const starts = [0];
  for (let at = 0; at < source.length; at += 1) if (source[at] === '\n') starts.push(at + 1);

  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * The changed line numbers of a zero-context diff of one file.
 *
 * Removed lines are numbered in the old file and added lines in the new one,
 * so each is looked up against the text it belongs to.
 *
 * @param {string} diff  `git diff -U0` of a single file
 * @returns {{removed: number[], added: number[]}}
 */
export function changedLines(diff) {
  const removed = [];
  const added = [];

  for (const match of String(diff ?? '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);

    for (let line = 0; line < oldCount; line += 1) removed.push(oldStart + line);
    for (let line = 0; line < newCount; line += 1) added.push(newStart + line);
  }

  return { removed, added };
}

/**
 * The channels whose calls a change touches in one file.
 *
 * `existed` is whether the channel was in this file before the change. A
 * channel that existed is a contract somebody depends on today; a new one is
 * a contract nothing uses yet, and build() treats the two differently.
 *
 * @param {{before: string, after: string, diff: string}} input
 * @returns {Array<{channel: string, existed: boolean}>}
 */
export function touchedChannels(input) {
  const { removed, added } = changedLines(input.diff);
  const touched = new Set();

  const collect = (blocks, lines) => {
    for (const line of lines) {
      for (const block of blocks) {
        if (line >= block.start && line <= block.end) for (const channel of block.channels) touched.add(channel);
      }
    }
  };

  collect(blocksOf(input.before), removed);
  collect(blocksOf(input.after), added);

  const before = channelsIn(input.before);
  return [...touched].sort().map((channel) => ({ channel, existed: before.has(channel) }));
}

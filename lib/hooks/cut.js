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

// What a read cut inside a block looks like, and what the model is told.
//
// Two handlers see reads: post-bash for shell commands, post-read for the
// Read and Grep tools. They differ in how they tell that a read went through
// a window, and agree on the rest: output that ends with more `{` opened than
// closed is a block cut short, and the rule is the same sentence. One owner,
// so the two cannot drift into two versions of the rule.

/**
 * How many `{` and `}` the text holds.
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
 * The decision for a windowed read: quiet when its output closes every block
 * it opens, the rule otherwise.
 *
 * @param {string[]} found     the windows, written as a reader would recognize them
 * @param {string} output
 * @param {string|undefined} pluginRoot
 * @returns {import('./dispatch.js').Decision}
 */
export function cutDecision(found, output, pluginRoot) {
  if (found.length === 0) return { block: false };
  const { opened, closed } = braces(output);
  if (opened <= closed) return { block: false };

  const rule = `${pluginRoot ?? '${CLAUDE_PLUGIN_ROOT}'}/knowledge/pitfalls.md`;
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

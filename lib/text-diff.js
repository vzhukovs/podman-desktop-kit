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

// A line diff of two texts, as unified hunks.
//
// For files outside any repository: the plan and its snapshots live under
// $PDKIT_HOME, and `git diff --no-index` would make a pure comparison of two
// strings depend on a process, a binary and its configured pager and colors.
// The texts are a plan's — hundreds of lines — so an LCS over what lies
// between the common head and tail is enough, and past a size where it would
// not be, the middle is shown as removed and added whole, which is still true.

/** Above this many cells, the middle is not aligned line by line. */
const ALIGN_LIMIT = 4_000_000;

/**
 * @typedef {object} Op
 * @property {' '|'-'|'+'} kind
 * @property {string} line
 */

/**
 * The edit script between two line lists.
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {Op[]}
 */
function script(before, after) {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > head && endAfter > head && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const a = before.slice(head, endBefore);
  const b = after.slice(head, endAfter);
  /** @type {Op[]} */
  const middle = [];
  if (a.length * b.length > ALIGN_LIMIT) {
    for (const line of a) middle.push({ kind: '-', line });
    for (const line of b) middle.push({ kind: '+', line });
  } else {
    // lengths[i * width + j]: the longest common subsequence of a[i..] and b[j..].
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        middle.push({ kind: ' ', line: a[i] });
        i++;
        j++;
      } else if (j >= b.length || (i < a.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        middle.push({ kind: '-', line: a[i] });
        i++;
      } else {
        middle.push({ kind: '+', line: b[j] });
        j++;
      }
    }
  }

  return [
    ...before.slice(0, head).map((line) => /** @type {Op} */ ({ kind: ' ', line })),
    ...middle,
    ...before.slice(endBefore).map((line) => /** @type {Op} */ ({ kind: ' ', line })),
  ];
}

/**
 * The hunks of a unified diff between two texts, without the file header.
 *
 * Empty when the texts are equal, and when they differ only in a newline at
 * the end. Line numbers in each `@@` header are 1-based; a side with no lines
 * in a hunk names the line before it, as git does.
 *
 * @param {string} before
 * @param {string} after
 * @param {{context?: number}} [options]   unchanged lines around each change, 3 by default
 * @returns {string[]}
 */
export function unified(before, after, options = {}) {
  const context = options.context ?? 3;
  // An empty text has no lines, and the newline that ends the last line is
  // not a line of its own: a file that does not exist on one side is all
  // added or all removed, not one blank line changed into many.
  const linesOf = (text) => (String(text ?? '') === '' ? [] : String(text).replace(/\n$/, '').split('\n'));
  const ops = script(linesOf(before), linesOf(after));

  const changed = ops.flatMap((op, at) => (op.kind === ' ' ? [] : [at]));
  if (changed.length === 0) return [];

  // Runs of changes no further apart than twice the context share a hunk.
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const at of changed) {
    const last = spans.at(-1);
    if (last && at - last[1] <= 2 * context + 1) last[1] = at;
    else spans.push([at, at]);
  }

  // The line numbers each op starts at, on either side.
  const oldAt = [];
  const newAt = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.kind !== '+') oldLine++;
    if (op.kind !== '-') newLine++;
  }

  const lines = [];
  for (const [first, last] of spans) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    const oldStart = oldCount === 0 ? oldAt[from] - 1 : oldAt[from];
    const newStart = newCount === 0 ? newAt[from] - 1 : newAt[from];
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) lines.push(`${op.kind}${op.line}`);
  }
  return lines;
}

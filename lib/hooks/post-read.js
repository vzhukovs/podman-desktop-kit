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

// PostToolUse handler for Read and Grep: a read that stopped inside a block.
//
// post-bash catches `grep -A60` and `sed -n a,bp` in the shell, and the model
// is told to prefer the Read and Grep tools over the shell. Those cut too:
// Read returns the first 2000 lines of a file unless told otherwise, and the
// extension API declarations run past 4500, so a plain Read of them ends in
// the middle of the newest namespace members; Grep has `-A`/`-B`/`-C` and
// `head_limit`. A hook on Bash alone covered the reads the model is told not
// to make and missed the ones it is told to make.
//
// Same two facts as post-bash: the tool reported a window, and the output
// ends with more `{` opened than closed (cut.js). The window is read off the
// tool's own report, not guessed: Read says which lines it returned out of how
// many, Grep says which context and limit it applied.
//
// Not scoped to podman-desktop, for the same reason as post-bash.

import { cutDecision } from './cut.js';

const CONTEXT_OPTIONS = ['-A', '-B', '-C', 'context'];

/**
 * The window a Read returned, or null when it returned the whole file.
 *
 * @param {{content?: string, startLine?: number, numLines?: number, totalLines?: number, truncatedByTokenCap?: boolean}} file
 * @returns {string|null}
 */
export function readWindow(file) {
  const start = Number(file?.startLine ?? 1);
  const count = Number(file?.numLines ?? 0);
  const total = Number(file?.totalLines ?? 0);
  if (!count || !total) return null;
  const end = start + count - 1;
  if (start <= 1 && end >= total && !file.truncatedByTokenCap) return null;
  return `Read lines ${start}-${end} of ${total}`;
}

/**
 * The windows a Grep applied: context around matches, and a cap on the output.
 *
 * @param {Record<string, unknown>} input
 * @param {{appliedLimit?: number}} response
 * @returns {string[]}
 */
export function grepWindows(input, response) {
  const found = [];
  for (const option of CONTEXT_OPTIONS) {
    const value = Number(input?.[option] ?? 0);
    if (value > 0) found.push(`Grep ${option === 'context' ? '-C' : option} ${value}`);
  }
  if (response?.appliedLimit != null) found.push(`Grep head_limit ${response.appliedLimit}`);
  return found;
}

/**
 * Say so when a Read or a Grep stopped inside a block.
 *
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: any}|null} payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, context) {
  const response = payload?.tool_response;
  if (payload?.tool_name === 'Read') {
    const window = readWindow(response?.file);
    return cutDecision(window ? [window] : [], String(response?.file?.content ?? ''), context?.pluginRoot);
  }
  if (payload?.tool_name === 'Grep') {
    if (typeof response?.content !== 'string') return { block: false };
    return cutDecision(grepWindows(payload.tool_input, response), response.content, context?.pluginRoot);
  }
  return { block: false };
}

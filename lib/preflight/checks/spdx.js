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

// Preflight check: spdx
//
// Every added file carries the license header in the repository's house format.
//
// Shares checkSpdx() with the post-write hook, so a file the hook accepted
// cannot fail here — two implementations of "what counts as a header" would
// eventually disagree, and the disagreement surfaces as a hook passing what
// preflight then rejects.
//
// Added files only. A modified file that never had a header is somebody else's
// omission, and making it this branch's problem grows the diff for no reason.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkSpdx } from '../../upstream.js';

/** @type {string} */
export const id = 'spdx';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const added = context.changed.filter((entry) => entry.status.startsWith('A'));
  const missing = [];
  let checked = 0;

  for (const entry of added) {
    let content;
    try {
      content = await readFile(join(context.repoRoot, entry.path), 'utf8');
    } catch {
      continue;
    }

    const result = checkSpdx({ path: entry.path, content });
    if (!result.required) continue;

    checked += 1;
    if (!result.present) missing.push(entry.path);
  }

  if (missing.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${missing.length} added file${missing.length === 1 ? '' : 's'} without the license header`,
      output: missing.join('\n'),
      remedy: 'add the Red Hat Apache block with the SPDX identifier inside it — the post-write hook prints the exact text',
    };
  }

  return {
    id,
    status: 'pass',
    blocking,
    summary: checked === 0 ? 'no added files need a header' : `${checked} added file${checked === 1 ? '' : 's'} carry the header`,
  };
}

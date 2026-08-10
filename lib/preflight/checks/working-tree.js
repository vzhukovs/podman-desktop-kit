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

// Preflight check: working tree
//
// Nothing uncommitted. First in the report because without it every other
// result is ambiguous.
//
// The checks in this suite read two different things. The file-based ones —
// spdx, api-surface, debug-leftovers — look at the committed diff, `base...ref`.
// The command-based ones — tests, lint, typecheck — run whatever is on disk. On
// a clean tree those are the same thing. On a dirty one the report mixes them,
// and it can go green on a diff that is not what would be pushed, or red on
// changes that are not in any commit.
//
// This was not theoretical. The first full run against the fork reported
// test:renderer failing; the cause was uncommitted work in packages/preload
// that the renderer tests pick up, while the file checks were reading a commit
// that did not contain it.

import { capture } from '../../evidence.js';

/** @type {string} */
export const id = 'working-tree';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const status = await capture({ command: 'git status --porcelain', cwd: context.repoRoot });

  const entries = status.stdout.split('\n').filter((line) => line.trim() !== '');
  const untracked = entries.filter((line) => line.startsWith('??'));
  const tracked = entries.filter((line) => !line.startsWith('??'));

  if (tracked.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${tracked.length} uncommitted change${tracked.length === 1 ? '' : 's'}: the commands below would run code that is in no commit`,
      output: entries.join('\n'),
      remedy: 'commit or stash. The file checks read base...HEAD and the command checks run the working tree; they only agree on a clean one',
    };
  }

  if (untracked.length > 0) {
    // Not blocking: an untracked scratch file changes nothing about what is
    // pushed. It is worth naming because vitest will happily collect an
    // untracked spec file and report on code no reviewer will ever see.
    return {
      id,
      status: 'warn',
      blocking,
      summary: `${untracked.length} untracked file${untracked.length === 1 ? '' : 's'}`,
      output: untracked.join('\n'),
      remedy: 'harmless unless one of them is a spec file, in which case the test run includes code that is not in the PR',
    };
  }

  return { id, status: 'pass', blocking, summary: 'clean' };
}

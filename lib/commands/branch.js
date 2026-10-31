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

// `pdkit branch`: create the branch for an issue or a slice.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import * as git from '../git.js';
import * as ids from '../ids.js';
import { EXIT, issueFlag, printJson, repoContext } from './support.js';

export const flags = ['issue', 'slug', 'index'];

/**
 * Create a branch, or check out the one that is already there.
 *
 * Not an error when it exists: re-running /pd:pr after fixing a preflight
 * failure is the normal case, and failing on the second run would make the
 * flow one-shot.
 *
 * @param {string} name
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, created: boolean, error?: string}>}
 */
async function createBranch(name, cwd) {
  try {
    await git.text(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd });
    await git.text(['checkout', name], { cwd });
    return { ok: true, created: false };
  } catch {
    // Not there yet.
  }

  try {
    await git.text(['checkout', '-b', name], { cwd });
    return { ok: true, created: true };
  } catch (error) {
    return { ok: false, created: false, error: String(error.stderr ?? error.message).trim() };
  }
}

/**
 * Create the branch for an issue or a slice.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  if (args[0] !== 'create') {
    process.stderr.write(`pdkit branch: unknown action "${args[0] ?? ''}" (create)\n`);
    return EXIT.ERROR;
  }

  const issue = issueFlag(flags);
  if (!Number.isInteger(issue) || typeof flags.slug !== 'string') {
    process.stderr.write('pdkit branch create: --issue and --slug are required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit branch create: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const index = flags.index === undefined ? undefined : Number.parseInt(String(flags.index), 10);
  const name = ids.branchName({ issue, slug: flags.slug, index, config: repo.config });

  const created = await createBranch(name, repo.root);
  if (!created.ok) {
    process.stderr.write(`pdkit branch create: ${created.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ branch: name, created: created.created });
  else process.stdout.write(`${name}${created.created ? ' (created)' : ' (already existed, checked out)'}\n`);

  return EXIT.OK;
}

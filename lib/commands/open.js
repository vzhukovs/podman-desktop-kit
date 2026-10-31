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

// `pdkit open`: open $PDKIT_HOME, an issue's directory in it, or an issue's
// worktree.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { existsSync } from 'node:fs';

import { issueDir, paths } from '../config.js';
import { openDir } from '../reveal.js';
import { EXIT, issueMeant, repoContext, reportOpened, treeOf, trustedHome } from './support.js';

export const flags = ['issue'];

/**
 * Open $PDKIT_HOME, an issue's directory in it, or an issue's worktree, in the
 * file manager.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const [where] = args;
  if (!['home', 'issue', 'tree'].includes(where)) {
    process.stderr.write('pdkit open: home | issue [<issue>] | tree [<issue>]\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const fail = (message) => {
    process.stderr.write(`pdkit open ${where}: ${message}\n`);
    return EXIT.ERROR;
  };

  if (where === 'tree') {
    const meant = await issueMeant(args[1] ?? flags.issue, repo);
    if (meant.error) return fail(meant.error);
    const tree = await treeOf(meant.issue, repo);
    if (tree.error) return fail(tree.error);
    return reportOpened(`open ${where}`, tree.path, await openDir(tree.path), flags);
  }

  const trusted = trustedHome(repo);
  if (trusted.error) return fail(trusted.error);

  let target = paths(trusted.home).home;
  if (where === 'issue') {
    const meant = await issueMeant(args[1] ?? flags.issue, repo);
    if (meant.error) return fail(meant.error);
    target = issueDir(trusted.home, meant.issue);
    if (!existsSync(target)) return fail(`issue ${meant.issue} has no state in ${trusted.home} — nothing has triaged it`);
  } else if (!existsSync(target)) {
    return fail(`${target} does not exist yet — run pdkit init`);
  }

  return reportOpened(`open ${where}`, target, await openDir(target), flags);
}

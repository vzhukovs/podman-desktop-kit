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


import * as audit from '../audit.js';
import { EXIT, commandLine, printJson, refusedRef, repoContext, requireIssueTree, shellWord } from './support.js';

export const flags = ['base', 'ref'];

/**
 * Collect the facts an audit works from.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit audit: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);

  // The auditor reads this diff as the issue's and judges it against the
  // issue's plan; read from the wrong tree, it judges another issue's work and
  // says so with confidence. `--ref` names the diff outright, so it is held to
  // the branch it names rather than to the tree.
  if (typeof flags.ref === 'string') {
    if (refusedRef('pdkit audit', issue, flags.ref)) return EXIT.ERROR;
  } else if (repo.root) {
    const held = await requireIssueTree({
      issue,
      repo,
      command: 'pdkit audit',
      words: ['audit', ...args],
      flags,
      alternative: (found) => (found.branch ? `${commandLine(['audit', ...args], flags)} --ref ${shellWord(found.branch)}` : null),
    });
    if (!held.ok) return EXIT.ERROR;
  }

  const report = await audit.collect({
    issue,
    repoRoot: repo.root ?? undefined,
    config: repo.config,
    base: typeof flags.base === 'string' ? flags.base : undefined,
    ref: typeof flags.ref === 'string' ? flags.ref : undefined,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(audit.format(report));

  // Always zero. This command reports; deciding whether the findings matter is
  // what pd-auditor is for, and an exit code here would be a verdict.
  return EXIT.OK;
}

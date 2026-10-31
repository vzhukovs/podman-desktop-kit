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

// `pdkit drift`: what landed upstream under each slice since it branched, and
// what touched lines the plan cites.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { resolveHome } from '../config.js';
import * as drift from '../drift.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = ['issue', 'upstream', 'ref', 'files'];

export async function run(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit drift: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit drift: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const report = await drift.collect({
    issue,
    repoRoot: repo.root,
    config: repo.config,
    home: resolveHome({ repoRoot: repo.root }),
    upstream: typeof flags.upstream === 'string' ? flags.upstream : undefined,
    // Both were reachable in the module and from nowhere else, so an issue
    // without a slice graph measured an empty set and said so as though it
    // were an answer.
    ref: typeof flags.ref === 'string' ? flags.ref : undefined,
    files: typeof flags.files === 'string' ? flags.files.split(',').map((name) => name.trim()).filter(Boolean) : undefined,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(drift.format(report));

  return EXIT.OK;
}

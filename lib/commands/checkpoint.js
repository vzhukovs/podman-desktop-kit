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

// `pdkit checkpoint`: the first step of a phase that changes things, so the
// phase can be undone; and the checkpoints an issue has.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import * as checkpoint from '../checkpoint.js';
import { resolveHome } from '../config.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = ['issue', 'phase'];

/**
 * The first step of a phase that changes things: copy the issue's artefacts and
 * record its state and branch heads, so the phase can be undone. `list` shows
 * the checkpoints an issue has.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const listing = args[0] === 'list';
  const issue = Number.parseInt(String((listing ? args[1] : args[0]) ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit checkpoint: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });

  if (listing) {
    const found = await checkpoint.list({ issue, home });
    if (flags.json) printJson(found);
    else if (found.length === 0) process.stdout.write(`DESKTOP-${issue}: no checkpoints\n`);
    else for (const entry of found) process.stdout.write(`  ${entry.id}  ${entry.phase.padEnd(8)} ${entry.at.slice(0, 16).replace('T', ' ')}  ${entry.record.state}\n`);
    return EXIT.OK;
  }

  const result = await checkpoint.take({ issue, phase: String(flags.phase ?? ''), repoRoot: repo.root, home });
  if (!result.ok) {
    process.stderr.write(`pdkit checkpoint: ${result.error}\n`);
    return EXIT.ERROR;
  }
  if (flags.json) printJson(result.meta);
  else {
    const branches = Object.keys(result.meta.branches.local).length;
    const trees = result.meta.trees?.length ?? 0;
    process.stdout.write(
      `${result.meta.id}  DESKTOP-${issue}  start of ${result.meta.phase}, ${result.meta.record.state}, ${branches} branch(es), ${trees} tree(s)` +
        `${repo.root ? '' : ' — no repository here, so no branch heads were recorded'}\n` +
        `  if this phase goes somewhere it should not: pdkit rollback ${issue}\n`,
    );
  }
  return EXIT.OK;
}

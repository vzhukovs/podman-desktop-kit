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


import * as checkpoint from '../checkpoint.js';
import { resolveHome } from '../config.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = ['issue', 'to', 'confirm'];

export async function run(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit rollback: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });
  const report = await checkpoint.plan({ issue, id: typeof flags.to === 'string' ? flags.to : undefined, repoRoot: repo.root, home });
  if (!report.ok) {
    process.stderr.write(`pdkit rollback: ${report.error}\n`);
    return EXIT.ERROR;
  }

  // Either refusal ends the dry run without the line that offers --confirm:
  // printed under a refusal, it reads as the way past it.
  const refused = Boolean(report.stateMoved) || report.branches.refused.length > 0;
  if (!flags.confirm) {
    if (flags.json) printJson({ ...report, confirmed: false });
    else {
      process.stdout.write(checkpoint.format(report));
      process.stdout.write(
        refused
          ? report.stateMoved
            ? '\n  Nothing has been done.\n'
            : `\n  Nothing has been done. Commit or stash what is named above, then run this again.\n`
          : `\n  Nothing has been done. To go ahead:\n    pdkit rollback ${issue} --to ${report.meta.id} --confirm\n`,
      );
    }
    return refused ? EXIT.ERROR : EXIT.OK;
  }

  const outcome = await checkpoint.apply({ issue, plan: report, repoRoot: repo.root, home });
  if (flags.json) printJson(outcome);
  if (!outcome.ok) {
    if (!flags.json) process.stderr.write(`pdkit rollback: ${outcome.error}\n`);
    return EXIT.ERROR;
  }
  if (!flags.json) {
    process.stdout.write(
      `DESKTOP-${issue}: back at ${report.meta.id}, the start of ${report.meta.phase}\n` +
        (outcome.backups.length > 0 ? `  previous tips: ${outcome.backups.join(', ')}\n` : '') +
        (outcome.archived ? `  previous artefacts: ${outcome.archived}\n` : '') +
        `  next: run ${report.meta.phase === 'pr-sync' ? '/pd:pr-sync' : `/pd:${report.meta.phase}`} again, in a new session\n`,
    );
  }
  return EXIT.OK;
}

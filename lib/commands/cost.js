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

// `pdkit cost`: what each issue cost in tokens, normalized by the size of the
// work; with --planning, what planning cost round by round, and what the plan
// needed after approval.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { load, resolveHome } from '../config.js';
import * as cost from '../cost.js';
import * as journal from '../journal.js';
import * as planning from '../planning.js';
import { resolveRepoRoot } from '../repo.js';
import { EXIT, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'since', 'snapshot', 'compare', 'json', 'transcripts', 'planning'];

/**
 * What each issue cost in tokens, normalized by the size of the work.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const repoFlag = typeof flags.repo === 'string' ? flags.repo : undefined;
  const config = await load({ repoRoot: repoFlag });
  const home = resolveHome({ repoRoot: repoFlag });

  let issue = null;
  if (flags.issue !== undefined) {
    issue = issueFlag(flags);
    if (!Number.isInteger(issue)) {
      process.stderr.write(`pdkit cost: --issue ${flags.issue} is not an issue number\n`);
      return EXIT.ERROR;
    }
  }

  let since = null;
  if (flags.since !== undefined) {
    const resolved = journal.resolveSince(String(flags.since));
    if (!resolved.ok) {
      process.stderr.write(`pdkit cost: ${resolved.error}\n`);
      return EXIT.ERROR;
    }
    since = resolved.at;
  }

  // A round is cut by journal entries, not by a date, and the planning report
  // has no snapshot to compare with yet: both would be flags that ran and did
  // not do what they say.
  const unplanned = ['since', 'compare'].find((name) => flags.planning && flags[name] !== undefined);
  if (unplanned) {
    process.stderr.write(`pdkit cost: --${unplanned} does not apply to --planning\n`);
    return EXIT.ERROR;
  }

  if (flags.compare !== undefined && typeof flags.compare !== 'string') {
    process.stderr.write('pdkit cost: --compare takes the date of a snapshot (YYYY-MM-DD)\n');
    return EXIT.ERROR;
  }
  // Read before measuring: a snapshot that is not there is the answer, and
  // finding out after a scan of every transcript is a slow way to learn it.
  const before = typeof flags.compare === 'string' ? await cost.readSnapshot(flags.compare, { home }) : null;

  let transcripts;
  if (typeof flags.transcripts === 'string') {
    transcripts = [flags.transcripts];
  } else {
    const repo = await resolveRepoRoot({ config, cwd: repoFlag });
    transcripts = await cost.transcriptDirs({ repoRoot: repo.root ?? repoFlag ?? process.cwd(), config });
  }

  if (flags.planning) return planningReport({ transcripts, home, issue }, flags);

  const report = await cost.collect({ transcripts, config, home, issue, since });

  const written = flags.snapshot && !report.skip ? await cost.writeSnapshot(report, { home }) : null;

  if (before) {
    const comparison = cost.compare(before, report);
    if (flags.json) printJson(comparison);
    else process.stdout.write(cost.formatComparison(comparison));
  } else if (flags.json) {
    printJson(written ? { ...report, snapshot: written } : report);
  } else {
    process.stdout.write(cost.format(report));
  }

  if (written && !flags.json) process.stdout.write(`snapshot written to ${written}\n`);
  if (flags.snapshot && report.skip) process.stderr.write('pdkit cost: no snapshot written — nothing was measured\n');

  // Zero, as for stats: a cost is not a pass or a fail, and a threshold here
  // would be the recommendation this command refuses to make.
  return EXIT.OK;
}

/**
 * What planning cost round by round, and what the plan needed after approval.
 *
 * @param {{transcripts: string[], home: string, issue: number|null}} input
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function planningReport(input, flags) {
  const report = await planning.collect(input);
  const written = flags.snapshot ? await planning.writeSnapshot(report, { home: input.home }) : null;

  if (flags.json) printJson(written ? { ...report, snapshot: written } : report);
  else process.stdout.write(planning.format(report));
  if (written && !flags.json) process.stdout.write(`snapshot written to ${written}\n`);

  // Zero, as for the cost report: a number of rounds is not a pass or a fail.
  return EXIT.OK;
}

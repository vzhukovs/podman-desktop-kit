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

// `pdkit e2e`: the stability series for a generated e2e test.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { resolveHome } from '../config.js';
import * as validation from '../validation.js';
import { EXIT, describeRun, printJson, repoContext, requireIssueTree } from './support.js';

export const flags = ['issue', 'runs'];

/**
 * The stability series for a generated e2e test.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  if (args[0] !== 'stability') {
    process.stderr.write('pdkit e2e: stability --issue <n> [--runs <k>]\n');
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit e2e stability: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit e2e stability: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const held = await requireIssueTree({ issue, repo, command: 'pdkit e2e stability', words: ['e2e', ...args], flags });
  if (!held.ok) return EXIT.ERROR;

  const runs = Number.parseInt(String(flags.runs), 10);
  const result = await validation.stability({
    issue,
    home: resolveHome({ repoRoot: repo.root }),
    repoRoot: repo.root,
    config: repo.config,
    runs: Number.isInteger(runs) ? runs : undefined,
  });

  // `last` is a capture, and a capture is what this used to print three times
  // over. --json gets the paths and digests, like everyone else.
  const { last, ...reported } = result;
  if (flags.json) printJson(reported);
  else {
    // A path, exit and digest per run. The series stops at the first red, so
    // only the last run can have a tail to show — describeRun decides that.
    for (const [index, entry] of (result.runs ?? []).entries()) {
      process.stdout.write(
        index === result.runs.length - 1 && last
          ? describeRun({ path: entry.path, run: last, digest: entry.digest })
          : `${entry.path}\n  exit ${entry.exitCode === null ? 'none — killed' : entry.exitCode}, ${entry.durationMs}ms, ${entry.digest}\n`,
      );
    }
    process.stdout.write(`\n${result.consecutive ?? 0} of ${result.wanted ?? '?'} consecutive green\n`);
    if (result.error) process.stdout.write(`  ${result.error}\n`);
  }

  return result.ok ? EXIT.OK : EXIT.ERROR;
}

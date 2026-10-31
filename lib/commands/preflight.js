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

// `pdkit preflight`: run the deterministic gates.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';

import { resolveHome } from '../config.js';
import * as gh from '../gh.js';
import * as pr from '../pr.js';
import * as preflight from '../preflight/index.js';
import * as preflightRecord from '../preflight/record.js';
import { EXIT, printJson, repoContext, requireIssueTree } from './support.js';

export const flags = ['slice', 'body', 'body-from-pr', 'body-only', 'only'];

/**
 * Run the deterministic gates.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit preflight: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit preflight: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  // Before the body is read and before a single check runs. On DESKTOP-18915
  // this was the branch-name check, twelfth in the list: tests, lint and
  // typecheck ran green on 18967's tree first. branch-name stays — it is how a
  // detached HEAD or a badly spelled branch in the issue's own tree is caught —
  // but a tree that belongs to another issue is refused here, in seconds.
  const held = await requireIssueTree({
    issue,
    repo,
    command: 'pdkit preflight',
    words: ['preflight', ...args],
    flags,
    json: { results: [] },
  });
  if (!held.ok) return EXIT.ERROR;

  // The body-dependent checks cannot run on the first pass, because the body
  // does not exist yet.
  // They report skip-with-a-reason rather than pass; green on the second pass,
  // with --body, is what the gate is issued from (section 4).
  let prBody = null;
  if (typeof flags.body === 'string' && flags['body-from-pr'] !== undefined) {
    process.stderr.write('pdkit preflight: --body and --body-from-pr name two bodies; give one\n');
    return EXIT.ERROR;
  }
  if (typeof flags.body === 'string') {
    try {
      prBody = await readFile(flags.body, 'utf8');
    } catch (error) {
      process.stderr.write(`pdkit preflight: cannot read ${flags.body} (${error.code ?? error.message})\n`);
      return EXIT.ERROR;
    }
  }
  // The body a reviewer is reading, for a pull request that already exists.
  // After a rebase or a review round the body is on GitHub and nowhere else, and
  // without this every /pd:pr-sync and /pd:resume improvised the same
  // `gh pr view --json body > file` to feed --body.
  if (flags['body-from-pr'] !== undefined) {
    const number = Number.parseInt(String(flags['body-from-pr']), 10);
    if (!Number.isInteger(number)) {
      process.stderr.write('pdkit preflight: --body-from-pr needs a pull request number\n');
      return EXIT.ERROR;
    }
    try {
      prBody = String((await gh.pullRequest(number, { config: repo.config, fields: 'body' })).body ?? '');
    } catch (error) {
      process.stderr.write(`pdkit preflight: cannot read the body of #${number} (${error.message})\n`);
      return EXIT.ERROR;
    }
  }

  const context = await preflight.prepare({
    issue,
    slice: flags.slice === undefined ? undefined : Number.parseInt(String(flags.slice), 10),
    repoRoot: repo.root,
    prBody,
  });

  // A run that cannot look at the right diff does not run. Every check would
  // otherwise answer about whatever is checked out, and answer confidently.
  if (context.problem) {
    if (flags.json) printJson({ issue, ok: false, problem: context.problem, results: [] });
    else process.stderr.write(`pdkit preflight: ${context.problem}\n`);
    return EXIT.ERROR;
  }

  let only = null;
  if (flags['body-only']) {
    // Without a body these four skip, and four skips read as green. That is
    // exactly the shape of a second pass that proves nothing, so it is refused
    // rather than allowed to look like a pass.
    if (prBody === null) {
      process.stderr.write('pdkit preflight: --body-only needs --body <file> or --body-from-pr <k>; without one these checks only skip\n');
      return EXIT.ERROR;
    }
    only = preflight.BODY_DEPENDENT;
  } else if (typeof flags.only === 'string') {
    only = flags.only.split(',').map((id) => id.trim());
  }

  let checks;
  try {
    checks = only === null ? null : await preflight.loadChecks(only);
  } catch (error) {
    process.stderr.write(`pdkit preflight: ${error.message}\n`);
    return EXIT.ERROR;
  }

  const report = await preflight.run(context, checks);

  // Written before it is printed, and written whatever the verdict. A record
  // kept only when green would be a record that cannot say a check was tried
  // and failed — and `preflight-green` is now earned from this file, so the
  // failing runs are half of what makes it evidence rather than a claim.
  const written = await preflightRecord.write({
    issue,
    report,
    context,
    bodyDependent: preflight.BODY_DEPENDENT,
    home: resolveHome({ repoRoot: repo.root }),
  });

  // `waitingFor` is for waitingForBody, not part of the JSON contract.
  const results = report.results.map(({ waitingFor, ...result }) => result);
  if (flags.json) printJson({ issue, ok: report.ok, body: prBody !== null, results, recorded: written.at });
  else {
    process.stdout.write(preflight.format(report));
    // Two passes make a green, and the first one alone does not. Said here
    // because this is the moment somebody decides they are done.
    if (report.ok && prBody === null) {
      // Counted from the results, not from the list. The list's length was
      // printed here as "8 checks … judged nothing" while five of the eight had
      // answered from the diff alone; only the ones that skipped for want of
      // the body judged nothing. The gate still wants every one of them run
      // with the body, so the second sentence is about the list.
      const waiting = preflight.waitingForBody(report.results);
      const total = preflight.BODY_DEPENDENT.length;
      // When the pull request is already open its body is the one to judge, and
      // saying "draft the body" about it sent two sessions looking for a draft.
      const book = await pr.read(issue, { home: resolveHome({ repoRoot: repo.root }) }).catch(() => null);
      const open = (book?.prs ?? []).find(
        (record) => record.state === 'open' && (context.slice === undefined || context.slice === null || record.slice === context.slice),
      );
      const source = open ? `--body-from-pr ${open.number}` : '--body <file>';
      process.stdout.write(
        (waiting.length > 0
          ? `\n  ${waiting.length} of ${total} body-dependent checks needed the pull request body and had none, so they judged nothing yet: ${waiting.join(', ')}.\n`
          : `\n  None of the ${total} body-dependent checks needed the pull request body on this diff.\n`) +
          `  \`pdkit preflight ${issue}${context.slice ? ` --slice ${context.slice}` : ''} --body-only ${source}\` runs all ${total} with it, and until it does\n` +
          `  \`pdkit state ${issue} --to preflight-green\` will refuse.\n`,
      );
    }
  }

  return report.ok ? EXIT.OK : EXIT.ERROR;
}

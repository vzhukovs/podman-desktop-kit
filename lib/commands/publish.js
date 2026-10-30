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

import { readFile } from 'node:fs/promises';

import { get, resolveHome } from '../config.js';
import * as gate from '../gate.js';
import * as git from '../git.js';
import * as pr from '../pr.js';
import * as preflightRecord from '../preflight/record.js';
import { currentBranch, revision } from '../repo.js';
import * as state from '../state.js';
import { EXIT, FAILURE_TAIL_LINES, issueFlag, openPullRequest, pullRequestBase, repoContext } from './support.js';

export const flags = ['issue', 'branch', 'title', 'body', 'slice', 'base', 'pr'];

/**
 * Publish a branch: earn preflight-green, open the token, push, open the pull
 * request. The four commands of `/pd:pr` step 8, in their order, as one.
 *
 * Nothing here asks anything, and nothing here is consent. Consent is step 6 of
 * the skill — the body and the branch, read by a person — and it happens BEFORE
 * this command is typed. What this removes is the model holding a sequence of
 * four commands in the right order: the journal had 152 push refusals against
 * 22 open pull requests, almost all of them that sequence run out of order.
 *
 * It wraps, it does not replace. `state`, `gate open`, `git push` and
 * `pr create` all still work alone, because someone standing in the middle of a
 * half-finished publication needs exactly one of them, not all four again.
 *
 * And it weakens nothing. preflight-green is reached by the same transition,
 * which reads what preflight wrote; the token is the same token, spent on the
 * push before the push runs — the hook's rule, because a push that failed after
 * reaching the remote is still a push — and on the pull request by
 * gh.createPullRequest, which checks it itself. There is deliberately no flag
 * to skip, force or extend any of it: one that seemed needed would be a finding
 * about the gate, not an option for this command.
 *
 * With --pr, the branch already has an open pull request and this is
 * `/pd:pr-sync` step 8's push: the same earning and the same token, then
 * `push --force-with-lease`, because that is how a rebased or cascaded branch
 * reaches its pull request, and the issue goes back to pr-open.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = issueFlag(flags);
  const branch = typeof flags.branch === 'string' ? flags.branch : null;
  const updating = flags.pr !== undefined;
  const prNumber = updating ? Number.parseInt(String(flags.pr), 10) : null;
  const sliceIndex = flags.slice === undefined ? null : Number.parseInt(String(flags.slice), 10);

  const say = (text) => process.stdout.write(`${text}\n`);
  const refuse = (text) => {
    process.stderr.write(`pdkit publish: ${text}\n`);
    return EXIT.ERROR;
  };

  if (!Number.isInteger(issue) || !branch) {
    return refuse('--issue and --branch are required');
  }
  if (updating) {
    if (!Number.isInteger(prNumber)) return refuse('--pr takes the number of the open pull request this branch updates');
    if (flags.title !== undefined || flags.body !== undefined || flags.base !== undefined) {
      return refuse('--pr updates a pull request that is already open; --title, --body and --base are for opening one');
    }
  } else if (typeof flags.title !== 'string' || typeof flags.body !== 'string') {
    return refuse('--title and --body <file> are required to open a pull request (or --pr <k> to update an open one)');
  }

  const repo = await repoContext(flags);
  if (!repo.root) return refuse(repo.problems.join('; '));
  const config = repo.config;
  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const remote = String(get(config, 'repo.fork_remote') ?? 'origin');

  // Everything that can refuse without publishing anything refuses first.
  //
  // The checkout has to be the branch: preflight-green is earned by the commit
  // that is checked out, and pushing another branch on the strength of it would
  // publish something no check ever saw.
  const standing = await currentBranch({ cwd: repo.root });
  if (standing !== branch) {
    return refuse(
      `the checkout is on ${standing ?? 'a detached HEAD'}, not ${branch}. preflight-green is earned by the commit ` +
        'checked out, so the branch being published has to be the one standing here',
    );
  }
  const head = await revision('HEAD', { cwd: repo.root });

  const body = updating ? null : await readFile(/** @type {string} */ (flags.body), 'utf8');

  let target = null;
  if (updating) {
    const book = await pr.read(issue, { home });
    const record = book?.prs.find((entry) => entry.number === prNumber) ?? null;
    if (!record) return refuse(`#${prNumber} is not registered under issue ${issue} (pdkit pr register)`);
    if (record.branch && record.branch !== branch) return refuse(`#${prNumber} is the pull request of ${record.branch}, not ${branch}`);
  } else {
    // Before the push rather than before the pull request, which is where
    // `pr create` alone has to check: a base upstream does not have is then a
    // refusal with nothing public, instead of a pushed branch with no PR.
    const resolved = await pullRequestBase({ issue, branch, base: flags.base, config, home });
    if (!resolved.ok) return refuse(resolved.error.trimEnd());
    target = resolved;
  }

  // 1. preflight-green, earned. The same transition `pdkit state --to` runs,
  // reading what preflight wrote for this commit on this branch.
  //
  // Already there is the case of a publish that stopped before its push, run
  // again. The state is not set a second time — it cannot be — and the evidence
  // is read again for the commit that is checked out now, with the same
  // function the transition uses. A HEAD that moved since is refused here.
  const before = await state.read(issue, { home });
  if (before.state === 'preflight-green') {
    const found = await preflightRecord.evidence(issue, { home, head, branch });
    if (!found.ok) {
      return refuse(
        `issue ${issue} is preflight-green, and preflight has not shown this commit ready:\n` +
          found.problems.map((problem) => `    ${problem}\n`).join('') +
          `  Run: pdkit preflight ${issue}${sliceIndex ? ` --slice ${sliceIndex}` : ''}, then again with --body-only --body <file>`,
      );
    }
    say(`issue ${issue}: preflight-green, and preflight's record still holds for ${String(head).slice(0, 9)}`);
  } else {
    const moved = await state.transition(issue, 'preflight-green', { slice: sliceIndex, head, branch, home });
    if (!moved.ok) {
      return refuse(
        `stopped before a token was issued or anything was pushed.\n${moved.error}\n` +
          '  What is missing is a preflight run. There is no other way to this state, and this command has none.',
      );
    }
    say(`issue ${issue}: ${moved.from} -> preflight-green`);
  }

  // 2. The token. One, for this branch, covering the push and — when opening —
  // the pull request, once each.
  const opened = await gate.open({ issue, branch, slice: sliceIndex ?? undefined, home });
  if (!opened.ok) return refuse(`no token was issued, nothing was pushed: ${opened.error}`);
  say(`push token for ${branch}, valid until ${opened.expiresAt}`);

  // 3. The push. Spent before it runs, as the hook spends it: this process
  // starts git itself, so the hook never sees the push and the token has to be
  // spent here or nowhere.
  const spent = await gate.close({ branch, kind: 'push' }, { home, use: 'push' });
  if (!spent.ok) return refuse(`nothing was pushed: ${spent.error}`);

  const pushArgs = ['push', ...(updating ? ['--force-with-lease'] : []), remote, branch];
  try {
    await git.text(pushArgs, { cwd: repo.root, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const said = String(error.stderr ?? error.message).trimEnd().split('\n').slice(-FAILURE_TAIL_LINES);
    return refuse(
      `git ${pushArgs.join(' ')} failed:\n${said.map((line) => `  | ${line}`).join('\n')}\n` +
        `  The token's push is spent and the issue is still preflight-green${updating ? '' : '; no pull request was opened'}.\n` +
        '  Show the person what failed. Once the cause is fixed and they confirm again, run this same\n' +
        '  pdkit publish: it re-reads the preflight record and issues a fresh token.',
    );
  }
  say(`pushed ${branch} to ${remote}${updating ? ' (--force-with-lease)' : ''}`);

  if (updating) {
    const moved = await state.transition(issue, 'pr-open', { reason: `#${prNumber} updated from ${String(head).slice(0, 9)}`, home });
    if (!moved.ok) {
      process.stderr.write(`pdkit publish: pushed to #${prNumber}, but the issue could not move back to pr-open: ${moved.error}\n`);
      return EXIT.ERROR;
    }
    say(`issue ${issue}: preflight-green -> pr-open`);
    return EXIT.OK;
  }

  // 4. The pull request, on the other half of the same token.
  let outcome;
  try {
    outcome = await openPullRequest({ issue, branch, base: target.base, index: target.index, title: /** @type {string} */ (flags.title), body: /** @type {string} */ (body), config, home });
  } catch (error) {
    // The one state worse than either outcome: public branch, no pull request.
    // Said in full, because the next person to read it has to finish it.
    const retry =
      `pdkit pr create --issue ${issue} --branch ${branch} --title ${JSON.stringify(flags.title)} --body ${flags.body}` +
      `${typeof flags.base === 'string' ? ` --base ${flags.base}` : ''}`;
    return refuse(
      `${branch} IS PUSHED to ${remote}, and the pull request was NOT opened: ${error.message}\n` +
        `  The token is half spent: the push is used, the pull request is not, until ${opened.expiresAt}.\n` +
        '  Do not push again. Once the cause is fixed, finish with:\n' +
        `    ${retry}\n` +
        `  After ${opened.expiresAt} the remaining half has expired as well; open a new token first —\n` +
        `    pdkit gate open --issue ${issue} --branch ${branch}\n` +
        '  — which the issue, still preflight-green, allows.',
    );
  }

  if (outcome.unrecorded) {
    process.stderr.write(`pdkit publish: opened ${outcome.result.url} but could not record it: ${outcome.unrecorded}\n`);
  }
  say(outcome.result.url);
  return EXIT.OK;
}

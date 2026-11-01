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

// `pdkit task`: mark, clear or show what a working tree is executing, and load
// the ownership the pre-write hook enforces.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { join } from 'node:path';

import * as active from '../active.js';
import { describeSynced, syncTasks, withdrawalFor, withdrawnMessage } from '../amendment.js';
import * as attempts from '../attempts.js';
import { resolveHome } from '../config.js';
import * as state from '../state.js';
import * as worktree from '../worktree.js';
import { EXIT, issueFlag, printJson, repoContext, requireIssueTree } from './support.js';

export const flags = ['issue', 'task', 'reason'];

export const ACTIONS = {
  show,
  start,
  stop,
  sync,
  attempts: showAttempts,
  unblock,
};

/**
 * Mark, clear or show what a working tree is executing, and load the ownership
 * the pre-write hook enforces.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0];
  const cwd = typeof flags.repo === 'string' ? flags.repo : process.cwd();

  if (!Object.hasOwn(ACTIONS, action)) {
    process.stderr.write(`pdkit task: unknown action "${action ?? ''}" (start, stop, show, sync, attempts, unblock)\n`);
    return EXIT.ERROR;
  }

  return ACTIONS[action]({ args, cwd }, flags);
}

async function show(context, flags) {
  const running = await active.list();
  if (flags.json) {
    printJson(running);
    return EXIT.OK;
  }
  if (running.length === 0) {
    process.stdout.write('no task is running in any working tree\n');
    return EXIT.OK;
  }
  for (const entry of running) {
    process.stdout.write(`${entry.taskId}  issue ${entry.issue}  ${entry.worktree}  since ${entry.startedAt}\n`);
  }
  return EXIT.OK;
}

async function start({ args, cwd }, flags) {
  const issue = issueFlag(flags);
  const taskId = typeof flags.task === 'string' ? flags.task : args[1];

  if (!Number.isInteger(issue) || !taskId) {
    process.stderr.write('pdkit task start: --issue and --task are required\n');
    return EXIT.ERROR;
  }

  const here = await active.worktreeFor(cwd);
  if (!here) {
    process.stderr.write(`pdkit task start: ${cwd} is not inside a git working tree\n`);
    return EXIT.ERROR;
  }

  // A task runs in the issue's own tree and nowhere else. The main checkout
  // is the template trees are made from: on DESKTOP-19818 exec started there,
  // committed T1 on a branch it named itself, and the checkpoint taken first
  // had no branch to record, so the rollback could not see the work. Unlike
  // the other commands, `unclaimed` is refused too: it is exactly the case of
  // a tree nobody created yet.
  const tree = await worktree.forIssue({ issue, cwd: here });
  if (tree.verdict !== 'ours') {
    const repo = await repoContext({ ...flags, repo: here });
    if (tree.home) {
      await requireIssueTree({ issue, repo: { root: here, config: repo.config }, command: 'pdkit task start', words: ['task', 'start'], flags });
      return EXIT.ERROR;
    }
    const root = await worktree.rootFor({ repoRoot: here, config: repo.config });
    process.stderr.write(
      `pdkit task start: DESKTOP-${issue} has no tree yet, and a task does not run in ${here}` +
        `${tree.here.main ? ', the main checkout, which stays a template for the trees' : ''}.\n` +
        '  Create it, then move the session there with the EnterWorktree tool, and start the task again:\n' +
        `    pdkit worktree create --issue ${issue} --slug <slug>\n` +
        `    EnterWorktree path: ${join(root, `DESKTOP-${issue}`)}\n` +
        '  The slug is a few words of the issue title; the branch it names is the one the pull request will carry.\n',
    );
    return EXIT.ERROR;
  }

  const record = await state.read(issue);
  const owns = record.owns?.[taskId];

  // A withdrawn task has no Owns set any more, which the hook alone would read
  // as an unsynced task and let write anywhere. Refused here, by name.
  const withdrawn = await withdrawalFor(issue, taskId, resolveHome());
  if (withdrawn) {
    process.stderr.write(withdrawnMessage('task start', issue, taskId, withdrawn));
    return EXIT.ERROR;
  }

  // Before the pointer is written, not after. A blocked task that is already
  // marked active is a task the next agent picks up and retries, which is the
  // loop this refusal exists to break.
  const tried = await attempts.status({ issue, taskId, config: (await repoContext(flags)).config });
  if (tried.blocked) {
    process.stderr.write(`pdkit task start: ${attempts.blockedMessage({ issue }, tried)}\n`);
    return EXIT.ERROR;
  }

  const started = await active.start({ issue, taskId, worktree: here });

  if (flags.json) printJson({ ...started, owns: owns ?? [] });
  else {
    process.stdout.write(`${taskId} of issue ${issue} is running in ${here}\n`);
    // Said at the moment it can still be fixed. The two empty cases mean
    // opposite things to the hook — unknown ownership allows everything,
    // declared-none refuses everything — and both are silent otherwise.
    if (!Array.isArray(owns)) {
      process.stdout.write(`  no Owns set recorded — writes are unconstrained until \`pdkit task sync --issue ${issue}\`\n`);
    } else if (owns.length === 0) {
      process.stdout.write('  owns nothing — a verification task, so every write it attempts is refused\n');
    } else {
      for (const entry of owns) process.stdout.write(`  owns ${entry}\n`);
    }
  }
  return EXIT.OK;
}

async function stop({ cwd }) {
  const worktree = await active.worktreeFor(cwd);
  if (!worktree) {
    process.stderr.write(`pdkit task stop: ${cwd} is not inside a git working tree\n`);
    return EXIT.ERROR;
  }

  const stopped = await active.stop({ worktree });
  process.stdout.write(stopped.record ? `${stopped.record.taskId} stopped in ${worktree}\n` : `nothing was running in ${worktree}\n`);
  return EXIT.OK;
}

async function sync(context, flags) {
  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit task sync: --issue is required\n');
    return EXIT.ERROR;
  }

  const synced = await syncTasks(issue, resolveHome());
  if (synced === null) {
    process.stderr.write(`pdkit task sync: issue ${issue} has no tasks/ directory yet\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson(synced);
  else {
    for (const entry of synced) process.stdout.write(`${describeSynced(entry)}\n`);
    if (synced.length === 0) process.stdout.write('no task files to read\n');
  }
  return EXIT.OK;
}

async function showAttempts({ args }, flags) {
  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit task attempts: --issue is required\n');
    return EXIT.ERROR;
  }

  const config = (await repoContext(flags)).config;
  const taskId = typeof flags.task === 'string' ? flags.task : null;
  const report = taskId ? [await attempts.status({ issue, taskId, config })] : await attempts.all({ issue, config });

  if (flags.json) {
    printJson(report);
    return EXIT.OK;
  }

  if (report.length === 0) {
    process.stdout.write(`issue ${issue}: no task has failed a capture\n`);
    return EXIT.OK;
  }

  for (const entry of report) {
    process.stdout.write(
      `${entry.taskId}  ${entry.attempts}${entry.max > 0 ? `/${entry.max}` : ''} failed capture(s)` +
        `${entry.blocked ? '  BLOCKED' : ''}${entry.since ? `  counting from ${entry.since}` : ''}\n`,
    );
    for (const detail of entry.details) process.stdout.write(`    ${detail}\n`);
  }
  return EXIT.OK;
}

async function unblock({ args }, flags) {
  const issue = issueFlag(flags);
  const taskId = typeof flags.task === 'string' ? flags.task : args[1];

  if (!Number.isInteger(issue) || !taskId) {
    process.stderr.write('pdkit task unblock: --issue and --task are required\n');
    return EXIT.ERROR;
  }

  // Required, never defaulted. An unblock with no reason is the rubber stamp
  // the ceiling exists to interrupt, and this is the only record of why
  // anyone expected the next attempt to go differently.
  if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
    process.stderr.write(
      'pdkit task unblock: --reason "<what is different this time>" is required.\n' +
        '  Not ceremony: the count restarts here, and in six weeks this line is the only thing that says\n' +
        '  whether the plan changed or somebody just wanted the loop to continue.\n',
    );
    return EXIT.ERROR;
  }

  await attempts.unblock({ issue, taskId, reason: flags.reason.trim() });
  process.stdout.write(`${taskId} of issue ${issue} may be attempted again; the count restarts\n`);
  return EXIT.OK;
}

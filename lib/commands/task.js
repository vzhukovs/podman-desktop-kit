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

// `pdkit task`: mark, clear or show what a working tree is executing, load
// the ownership the pre-write hook enforces, show the queue of an issue, and
// record why a task stopped on the plan.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as active from '../active.js';
import { describeSynced, syncTasks, withdrawalFor, withdrawnMessage } from '../amendment.js';
import { parsePlan } from '../artefacts.js';
import * as attempts from '../attempts.js';
import { issueDir, resolveHome } from '../config.js';
import * as pr from '../pr.js';
import * as queue from '../queue.js';
import * as state from '../state.js';
import * as stops from '../stops.js';
import * as worktree from '../worktree.js';
import { EXIT, issueFlag, printJson, repoContext, requireIssueTree } from './support.js';

export const flags = ['issue', 'task', 'reason', 'finding', 'report'];

export const ACTIONS = {
  show,
  list,
  start,
  stop,
  clear,
  sync,
  attempts: showAttempts,
  unblock,
};

/**
 * Mark, clear or show what a working tree is executing, load the ownership the
 * pre-write hook enforces, show the queue, and record stops on the plan.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0];
  const cwd = typeof flags.repo === 'string' ? flags.repo : process.cwd();

  if (!Object.hasOwn(ACTIONS, action)) {
    process.stderr.write(`pdkit task: unknown action "${action ?? ''}" (list, start, stop, clear, show, sync, attempts, unblock)\n`);
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
  const recorded = await pr.openBranches(issue, { home: resolveHome() });
  const tree = await worktree.forIssue({ issue, cwd: here, recorded });
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

  // The plan's order and its open stop reports, from the same queue `task
  // list` prints. Refused here rather than left to the skill: an exec session
  // that picks its own order ran a plan's first task fourth, on a tree its
  // Done when could not pass on.
  const refusal = await queueRefusal(issue, taskId, flags);
  if (refusal) {
    process.stderr.write(refusal);
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

async function stop({ cwd }, flags) {
  const worktree = await active.worktreeFor(cwd);
  if (!worktree && typeof flags.finding !== 'string') {
    process.stderr.write(`pdkit task stop: ${cwd} is not inside a git working tree\n`);
    return EXIT.ERROR;
  }
  if (typeof flags.finding === 'string') return stopOnFinding(worktree, flags);

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

/**
 * Why a task may not start yet, as the text to print, or null when it may.
 *
 * @param {number} issue
 * @param {string} taskId
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<string|null>}
 */
async function queueRefusal(issue, taskId, flags) {
  const found = await queue.collect({ issue, config: (await repoContext(flags)).config });
  if (!found.found) return null;

  const entry = found.tasks.find((task) => task.id === taskId);
  if (!entry) return null;

  if (entry.status === 'stopped') {
    return (
      `pdkit task start: ${taskId} of issue ${issue} stopped on the plan, and ${entry.stops.map((id) => `stops/${id}.md`).join(', ')} ${entry.stops.length === 1 ? 'is' : 'are'} still open.\n` +
      '  It starts again once an amendment replaces it — `pdkit amendment draft --issue ' + issue + '` turns the open reports\n' +
      '  into a values file, in a new session — or once a person sets the report aside:\n' +
      `    pdkit task clear --issue ${issue} --report ${entry.stops[0]} --reason "<why the plan was right after all>"\n`
    );
  }

  if (entry.status === 'waiting') {
    const status = new Map(found.tasks.map((task) => [task.id, task]));
    const lines = entry.waitingOn.map((id) => {
      const need = status.get(id);
      const why = need?.status === 'stopped' ? `stopped — ${need.stops.map((report) => `stops/${report}.md`).join(', ')}` : (need?.status ?? 'unknown');
      return `    ${id}  ${why}`;
    });
    return (
      `pdkit task start: ${taskId} of issue ${issue} waits on ${entry.waitingOn.join(', ')}, which ${entry.waitingOn.length === 1 ? 'is' : 'are'} not done:\n` +
      `${lines.join('\n')}\n` +
      `  The order is the plan's "After" line. \`pdkit task list --issue ${issue}\` names the task that can run now.\n` +
      '  If the order itself is wrong, that is a finding about the plan, not a reason to start out of turn.\n'
    );
  }

  return null;
}

/** What `task list` prints in its status column. */
const MARK = {
  done: 'done',
  running: 'running',
  stopped: 'STOPPED',
  blocked: 'BLOCKED',
  waiting: 'waiting',
  ready: 'ready',
  withdrawn: 'withdrawn',
};

async function list({ args }, flags) {
  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit task list: --issue is required\n');
    return EXIT.ERROR;
  }

  const found = await queue.collect({ issue, config: (await repoContext(flags)).config });
  if (flags.json) {
    printJson(found);
    return found.found ? EXIT.OK : EXIT.ERROR;
  }
  if (!found.found) {
    process.stderr.write(`pdkit task list: ${found.reason}\n`);
    return EXIT.ERROR;
  }

  const counts = queue.STATUSES.map((status) => [status, found.tasks.filter((task) => task.status === status).length]).filter(([, n]) => n > 0);
  process.stdout.write(`issue ${issue}: ${counts.map(([status, n]) => `${n} ${status}`).join(' · ')}\n`);

  const width = Math.max(3, ...found.tasks.map((task) => task.id.length));
  const sliceWidth = Math.max(0, ...found.tasks.map((task) => (task.slice ?? '').length));
  for (const task of found.tasks) {
    const head = `  ${MARK[task.status].padEnd(9)} ${task.id.padEnd(width)} ${sliceWidth ? `${(task.slice ?? '').padEnd(sliceWidth)} ` : ''}`;
    process.stdout.write(`${head}${task.title}${describeEntry(task)}\n`);
  }
  for (const problem of found.problems) process.stdout.write(`  ✘ ${problem}\n`);

  process.stdout.write(`\n${nextLine(issue, found)}\n`);
  return EXIT.OK;
}

/**
 * The tail of a queue line: what the status alone does not say.
 *
 * @param {import('../queue.js').QueueEntry} task
 * @returns {string}
 */
function describeEntry(task) {
  if (task.status === 'withdrawn') {
    return `  → ${task.replacedBy.join(', ') || 'no replacement'}${task.amendment ? ` (${task.amendment})` : ''}`;
  }
  if (task.status === 'stopped') return `  — ${task.stops.map((id) => `stops/${id}.md`).join(', ')}`;
  if (task.status === 'waiting') return `  — after ${task.waitingOn.join(', ')}`;
  if (task.status === 'blocked') return `  — ${task.attempts.attempts}/${task.attempts.max} failed captures`;
  if ((task.status === 'ready' || task.status === 'waiting') && (task.receipt === 'failed' || task.receipt === 'invalid')) {
    return `  — receipt ${task.receipt}${task.receiptDetail ? `: ${task.receiptDetail}` : ''}`;
  }
  return '';
}

/**
 * The line that says what to do next, whatever the queue looks like.
 *
 * @param {number} issue
 * @param {{tasks: import('../queue.js').QueueEntry[], next: string|null}} found
 * @returns {string}
 */
function nextLine(issue, found) {
  if (found.next) return `next: ${found.next} — pdkit task start --issue ${issue} --task ${found.next}`;

  const live = found.tasks.filter((task) => task.status !== 'withdrawn');
  const running = live.filter((task) => task.status === 'running');
  if (running.length > 0) return `next: nothing new — ${running.map((task) => task.id).join(', ')} ${running.length === 1 ? 'is' : 'are'} running`;
  if (live.length > 0 && live.every((task) => task.status === 'done')) {
    return `next: every task has a passing receipt — pdkit state ${issue} --to implemented`;
  }

  const stopped = live.filter((task) => task.status === 'stopped');
  const blocked = live.filter((task) => task.status === 'blocked');
  const parts = [];
  if (stopped.length > 0) {
    parts.push(
      `${stopped.map((task) => task.id).join(', ')} stopped on the plan. In a new session on opus: pdkit amendment draft --issue ${issue}, ` +
        'finish the values it writes, pdkit amendment new, review, approve',
    );
  }
  if (blocked.length > 0) parts.push(`${blocked.map((task) => task.id).join(', ')} out of attempts — pdkit task attempts --issue ${issue}`);
  return `next: nothing can start. ${parts.join('; ') || 'Every remaining task waits on another.'}`;
}

/**
 * Record why a task stopped on the plan, then stop it.
 *
 * The task is the one running in this tree unless --issue and --task name
 * another: a task found blocked by the same cause before it ever started gets
 * its report too.
 *
 * @param {string|null} worktree
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function stopOnFinding(worktree, flags) {
  const running = worktree ? await active.current({ worktree }) : null;
  const issue = Number.isInteger(issueFlag(flags)) ? issueFlag(flags) : running?.issue;
  const taskId = typeof flags.task === 'string' ? flags.task : running?.taskId;
  if (!Number.isInteger(issue) || !taskId) {
    process.stderr.write('pdkit task stop --finding: no task is running here; name it with --issue <n> --task <T>\n');
    return EXIT.ERROR;
  }

  let values;
  try {
    values = JSON.parse(await readFile(String(flags.finding), 'utf8'));
  } catch (error) {
    process.stderr.write(`pdkit task stop --finding: ${flags.finding} is not a JSON values file (${error.message})\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome();
  const planText = await readFile(join(issueDir(home, issue), 'plan.md'), 'utf8').catch(() => null);
  const record = await state.read(issue, { home });
  const problems = stops.problemsOf(values, { taskId, plan: planText === null ? null : parsePlan(planText), withdrawn: record.withdrawn ?? {} });
  if (problems.length > 0) {
    process.stderr.write(`pdkit task stop --finding: the report for ${taskId} is not written, and the task is still running:\n`);
    for (const problem of problems) process.stderr.write(`  ✘ ${problem}\n`);
    process.stderr.write(
      '  Values: {"wrong", "evidence", "decision", "proposal"} required; "command", "files", "affects": [...],\n' +
        '  "unaffected": {"T<k>": "why"} optional. See templates/stop-report.md for what each section is for.\n',
    );
    return EXIT.ERROR;
  }

  const written = await stops.write({ issue, taskId, values, home });
  const stopped = running && running.taskId === taskId && running.issue === issue ? await active.stop({ worktree }) : null;

  if (flags.json) printJson({ ...written, issue, task: taskId, stopped: Boolean(stopped?.record) });
  else {
    process.stdout.write(`${written.path}\n`);
    process.stdout.write(stopped?.record ? `${taskId} stopped in ${worktree}\n` : `${taskId} was not running here; the report is recorded\n`);
    process.stdout.write(
      `  ${taskId} will not start again until an amendment replaces it or the report is cleared.\n` +
        `  Tasks that do not wait on it can still run: pdkit task list --issue ${issue}\n` +
        `  The amendment is written in a new session on opus: pdkit amendment draft --issue ${issue}\n`,
    );
  }
  return EXIT.OK;
}

async function clear({ args }, flags) {
  const issue = issueFlag(flags);
  const id = typeof flags.report === 'string' ? flags.report : args[1];
  if (!Number.isInteger(issue) || !id) {
    process.stderr.write('pdkit task clear: --issue and --report <T11-1> are required\n');
    return EXIT.ERROR;
  }
  if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
    process.stderr.write(
      'pdkit task clear: --reason "<why the plan was right after all>" is required.\n' +
        '  A report set aside without one reads, a week later, exactly like a finding somebody ignored.\n',
    );
    return EXIT.ERROR;
  }

  const report = (await stops.read(issue)).find((entry) => entry.id === id);
  if (!report) {
    process.stderr.write(`pdkit task clear: issue ${issue} has no stop report ${id}\n`);
    return EXIT.ERROR;
  }
  if (report.status !== 'open') {
    process.stderr.write(`pdkit task clear: ${id} is already ${report.status}\n`);
    return EXIT.ERROR;
  }

  await stops.clear({ issue, id, reason: flags.reason.trim() });
  process.stdout.write(`${id} set aside; ${report.names.join(', ')} may start again in the plan's order\n`);
  return EXIT.OK;
}

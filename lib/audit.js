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

// The facts pd-auditor works from.
//
// The auditor asks three questions: which requirements have no code, which code
// answers no requirement, and what changed outside the declared ownership. The
// third is a set difference between the diff and the Owns map — mechanical, and
// therefore not something an Opus should be spending judgment on. The first
// two are mechanical at the level of the map (a requirement with no task, a
// task with no requirement) and judgment below it (a requirement with a task
// whose code does something else). This module answers everything mechanical
// and stops exactly there.
//
// Nothing here decides. There is no verdict field, no ok flag over the whole
// report, and no state transition — a collector that graded its own findings
// would be the second opinion the audit is supposed to be getting.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { checkPlan, parsePlan, parseTask } from './artefacts.js';
import { get, issueDir, resolveHome } from './config.js';
import { validateReceipt } from './evidence.js';
import { matchesAny } from './globs.js';
import { read as readJournal } from './journal.js';
import { changedPaths, resolveBase } from './repo.js';
import { read as readState } from './state.js';

/**
 * What one planned task has to show for itself, for the auditor to read.
 *
 * `receipt` distinguishes four outcomes rather than two because they call for
 * different things: `missing` means nobody ran it, `invalid` means the file was
 * edited after it was written, and `failed` means it ran and did not pass. Only
 * the first is an oversight; the second is the one worth stopping on.
 *
 * @typedef {object} TaskFacts
 * @property {string} id
 * @property {string[]} satisfies
 * @property {string[]} owns
 * A withdrawn task is listed and not counted. Its receipt is still read — one
 * written before the amendment is a fact about what was done — but a missing
 * one is not an oversight, and a reader told "receipts not ok: T2, T3, T4" about
 * tasks an approved amendment replaced goes looking for work nobody owes.
 *
 * @property {'ok'|'missing'|'invalid'|'failed'} receipt
 * @property {string} [receiptDetail]
 * @property {string} [command]
 * @property {{amendment: string|null, replacedBy: string[]}|null} withdrawn
 * @property {Worker} worker
 */

/**
 * Which subagents finished while a task was active, as the journal recorded it.
 *
 * `unrecorded` is not `none`. A task whose every start came before the first
 * `agent-done` the journal holds ran while the SubagentStop hook was recording
 * nothing — for four months it was registered on an event subagents never
 * raise — and reporting "no implementer" for it would claim more than was
 * measured.
 *
 * @typedef {object} Worker
 * @property {'implementer'|'other'|'none'|'unrecorded'|'not-started'} seen
 * @property {number} implementerRuns  `pd-implementer` runs while the task was active
 * @property {string[]} others          the other agent types, `type not recorded` when the host sent none
 */

/**
 * Read an issue artefact, or null when it is not there.
 *
 * @param {string} home
 * @param {number} issue
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function artefact(home, issue, path) {
  try {
    return await readFile(join(issueDir(home, issue), path), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Every task file of an issue, in numeric order.
 *
 * Sorted numerically rather than lexically so T10 comes after T9. A report that
 * lists tasks in the wrong order is read as one that lost some.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<Array<import('./artefacts.js').Task>>}
 */
async function taskFiles(home, issue) {
  let entries;
  try {
    entries = await readdir(join(issueDir(home, issue), 'tasks'));
  } catch {
    return [];
  }

  const tasks = [];
  for (const entry of entries.filter((name) => /^T\d+\.md$/.test(name))) {
    const text = await artefact(home, issue, join('tasks', entry));
    if (text !== null) tasks.push(parseTask(text));
  }

  return tasks.sort((left, right) => Number.parseInt(left.id.slice(1), 10) - Number.parseInt(right.id.slice(1), 10));
}

/**
 * The state of a task's receipt.
 *
 * @param {string} home
 * @param {number} issue
 * @param {string} taskId
 * @returns {Promise<{receipt: TaskFacts['receipt'], receiptDetail?: string, command?: string}>}
 */
async function receiptFor(home, issue, taskId) {
  const content = await artefact(home, issue, join('receipts', `${taskId}.md`));
  if (content === null) return { receipt: 'missing' };

  const checked = validateReceipt(content);
  if (!checked.ok) return { receipt: 'invalid', receiptDetail: checked.reason };
  if (checked.exitCode !== 0) {
    return {
      receipt: 'failed',
      receiptDetail: `exit ${checked.exitCode === null ? 'none — killed' : checked.exitCode}`,
      command: checked.command,
    };
  }

  return { receipt: 'ok', command: checked.command };
}

/** The agent type SubagentStop reports for this plugin's implementer. */
const IMPLEMENTER = /(^|:)pd-implementer$/;

/**
 * Who did each task, from the journal.
 *
 * `agent-done` names the task that was active in the agent's working tree
 * ("while T1 was active"), so a run is tied to a task without trusting
 * anything the agent said about itself. Every start of the task counts, not the
 * last one: a task restarted in a new session was still worked on before.
 *
 * Reports and never decides. A task done in this session rather than by a
 * worker can be the right call — a task with nothing to own is one command —
 * and the audit says which it was, not whether that was allowed.
 *
 * @param {string} home
 * @param {number} issue
 * @param {string[]} taskIds
 * @returns {Promise<Map<string, Worker>>}
 */
async function workersFor(home, issue, taskIds) {
  const entries = await readJournal({ issue }, { home }).catch(() => []);
  const firstRun = (await readJournal({ event: 'agent-done' }, { home }).catch(() => []))[0]?.at ?? null;

  /** @type {Map<string, Worker>} */
  const workers = new Map();
  for (const id of taskIds) {
    const starts = entries.filter((entry) => entry.event === 'task-start' && entry.detail.split(' ')[0] === id);
    const runs = entries
      .filter((entry) => entry.event === 'agent-done')
      .map((entry) => entry.detail.split('; '))
      .filter((parts) => parts.includes(`while ${id} was active`));

    const implementerRuns = runs.filter((parts) => parts.slice(1).some((part) => IMPLEMENTER.test(part))).length;
    const others = [
      ...new Set(
        runs
          .filter((parts) => !parts.slice(1).some((part) => IMPLEMENTER.test(part)))
          .map((parts) => parts.slice(1).find((part) => !part.startsWith('while ')) ?? 'type not recorded'),
      ),
    ];

    let seen;
    if (implementerRuns > 0) seen = 'implementer';
    else if (others.length > 0) seen = 'other';
    else if (starts.length === 0) seen = 'not-started';
    else if (firstRun === null || starts.every((entry) => entry.at < firstRun)) seen = 'unrecorded';
    else seen = 'none';

    workers.set(id, { seen, implementerRuns, others });
  }
  return workers;
}

/**
 * Collect what can be established without judgment.
 *
 * @param {{issue: number, repoRoot?: string, base?: string, ref?: string, config?: object, home?: string}} input
 * @returns {Promise<object>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome();
  const issue = input.issue;
  const config = input.config ?? {};

  const record = await readState(issue, { home });
  const planText = await artefact(home, issue, 'plan.md');
  const plan = planText === null ? null : parsePlan(planText);

  const tasks = await taskFiles(home, issue);
  /** @type {TaskFacts[]} */
  const facts = [];

  // From the record, the task file, or a task in plan.md that replaces it —
  // whichever says so. They are written apart, and any one is enough for the
  // task not to be work anybody owes; the last is also what the plan check
  // above goes by, and the two halves of one report should not disagree.
  const withdrawal = (id, fromFile) => {
    const held = record.withdrawn?.[id];
    if (held) return { amendment: held.amendment ?? null, replacedBy: held.replacedBy ?? [] };
    if (fromFile) return fromFile;
    const replacer = plan?.tasks.find((task) => task.id === id)?.replacedBy;
    return replacer ? { amendment: null, replacedBy: [replacer] } : null;
  };

  for (const task of tasks) {
    facts.push({
      id: task.id,
      satisfies: task.satisfies,
      owns: task.owns,
      ...(await receiptFor(home, issue, task.id)),
      withdrawn: withdrawal(task.id, task.withdrawn),
    });
  }

  // The plan is the fallback source of tasks. A quickfix has no task files at
  // all, and an issue mid-planning may have a plan before it has them.
  if (facts.length === 0 && plan) {
    for (const task of plan.tasks) {
      facts.push({
        id: task.id,
        satisfies: task.satisfies,
        owns: task.owns,
        ...(await receiptFor(home, issue, task.id)),
        withdrawn: withdrawal(task.id, null),
      });
    }
  }
  const live = facts.filter((task) => !task.withdrawn);

  const workers = await workersFor(home, issue, facts.map((task) => task.id));
  for (const task of facts) task.worker = /** @type {Worker} */ (workers.get(task.id));

  // The base was the literal 'main' — not even `repo.base_branch`, so a fork
  // whose base branch is called anything else audited against a ref that may
  // not exist. And a branch NAME is the wrong thing to diff against on a fork:
  // the local copy is as current as the last pull, which is how preflight came
  // to report on 491 commits of other people's work (0.11). Same resolver, same
  // reason.
  const named = input.base ?? String(get(config, 'repo.base_branch') ?? 'main');
  const resolved = input.repoRoot ? await resolveBase({ cwd: input.repoRoot, base: named, config }) : { ref: named };

  const changed = input.repoRoot
    ? await changedPaths(resolved.ref, input.ref ?? 'HEAD', { cwd: input.repoRoot })
    : [];

  // Live tasks only. A file a withdrawn task used to own is owned by nobody now,
  // and a change to it is exactly what this list is for.
  const owned = live.flatMap((task) => task.owns);
  // The reason this is here rather than in the pre-write hook: the hook is
  // silent when no task was ever started, so this is the only place a file
  // written outside every Owns set is certain to be seen.
  const unowned = changed.filter((entry) => !matchesAny(entry.path, owned)).map((entry) => entry.path);

  const declared = record.requirements.ids.length ? record.requirements.ids : (plan?.requirements ?? []);
  const covered = new Set(live.flatMap((task) => task.satisfies));

  return {
    issue,
    state: record.state,
    route: record.route,
    requirements: { ids: declared, frozen: record.requirements.frozen },
    plan: plan
      ? { found: true, ...(await checkPlan({ plan, content: planText, record })) }
      : { found: false, ok: false, problems: [{ check: 'plan', detail: 'there is no plan.md for this issue' }], warnings: [] },
    tasks: facts,
    diff: {
      base: resolved.ref,
      ref: input.ref ?? 'HEAD',
      repo: input.repoRoot ?? null,
      files: changed,
    },
    unowned,
    uncovered: declared.filter((id) => !covered.has(id)),
    unsatisfying: live.filter((task) => task.satisfies.length === 0).map((task) => task.id),
    receipts: {
      missing: live.filter((task) => task.receipt === 'missing').map((task) => task.id),
      invalid: live.filter((task) => task.receipt === 'invalid').map((task) => task.id),
      failed: live.filter((task) => task.receipt === 'failed').map((task) => task.id),
    },
    withdrawn: facts
      .filter((task) => task.withdrawn)
      .map((task) => ({ id: task.id, amendment: task.withdrawn.amendment, replacedBy: task.withdrawn.replacedBy })),
    workers: {
      withoutImplementer: live.filter((task) => task.worker.seen === 'other' || task.worker.seen === 'none').map((task) => task.id),
      unrecorded: live.filter((task) => task.worker.seen === 'unrecorded').map((task) => task.id),
      notStarted: live.filter((task) => task.worker.seen === 'not-started').map((task) => task.id),
    },
  };
}

/**
 * @param {Worker} worker
 * @returns {string}
 */
function describeWorker(worker) {
  if (worker.seen === 'implementer') return `pd-implementer ×${worker.implementerRuns}`;
  if (worker.seen === 'other') return `no pd-implementer (ran: ${worker.others.join(', ')})`;
  if (worker.seen === 'none') return 'no subagent';
  if (worker.seen === 'unrecorded') return 'not recorded';
  return 'never started';
}

/**
 * Render a report for a terminal.
 *
 * Ordered so the reader meets the machine-checkable failures before the diff:
 * a missing receipt or an unowned file changes what is worth reading in the
 * diff at all.
 *
 * @param {Awaited<ReturnType<typeof collect>>} report
 * @returns {string}
 */
export function format(report) {
  const lines = [
    `audit: issue ${report.issue} — ${report.state}${report.route ? `, ${report.route}` : ''}`,
    `  requirements : ${report.requirements.ids.join(', ') || '—'}${report.requirements.frozen ? ' (frozen)' : ' (NOT frozen)'}`,
    '',
  ];

  if (!report.plan.found) lines.push('  plan         : none', '');
  else {
    lines.push(`  plan         : ${report.plan.ok ? 'passes the mechanical checks' : `${report.plan.problems.length} problem(s)`}`);
    for (const problem of report.plan.problems) lines.push(`    ✘ ${problem.check}: ${problem.detail}`);
    for (const warning of report.plan.warnings) lines.push(`    ! ${warning.check}: ${warning.detail}`);
    lines.push('');
  }

  lines.push('  tasks:');
  if (report.tasks.length === 0) lines.push('    none');
  for (const task of report.tasks) {
    if (task.withdrawn) {
      const by = task.withdrawn.amendment ? ` by ${task.withdrawn.amendment} (amendments/${task.withdrawn.amendment}.md)` : '';
      const replaced = task.withdrawn.replacedBy.length ? `, replaced by ${task.withdrawn.replacedBy.join(', ')}` : '';
      lines.push(`    – ${task.id}  withdrawn${by}${replaced}  receipt ${task.receipt === 'missing' ? 'not owed' : task.receipt}`);
      continue;
    }
    const mark = { ok: '✔', missing: '✘', invalid: '✘', failed: '✘' }[task.receipt];
    lines.push(
      `    ${mark} ${task.id}  satisfies ${task.satisfies.join(', ') || '—'}  receipt ${task.receipt}` +
        `${task.receiptDetail ? ` (${task.receiptDetail})` : ''}  worker ${describeWorker(task.worker)}`,
    );
    for (const entry of task.owns) lines.push(`        owns ${entry}`);
  }
  lines.push('');

  lines.push(`  diff         : ${report.diff.files.length} file(s) ${report.diff.base}...${report.diff.ref}`);
  if (report.unowned.length) {
    lines.push('  changed outside every task’s ownership:');
    for (const path of report.unowned) lines.push(`    ✘ ${path}`);
  }
  if (report.uncovered.length) lines.push(`  requirements with no task: ${report.uncovered.join(', ')}`);
  if (report.unsatisfying.length) lines.push(`  tasks with no requirement: ${report.unsatisfying.join(', ')}`);
  if (report.workers.withoutImplementer.length) {
    lines.push(
      `  tasks no pd-implementer ran for: ${report.workers.withoutImplementer.join(', ')} ` +
        `(${report.workers.withoutImplementer.length} of ${report.tasks.length - report.withdrawn.length})`,
    );
  }
  if (report.workers.unrecorded.length) {
    lines.push(`  tasks started before the journal recorded any subagent: ${report.workers.unrecorded.join(', ')}`);
  }

  lines.push(
    '',
    '  These are facts, not a verdict. What is left is what no grep answers:',
    '  a requirement whose code does something else, code that answers nothing,',
    '  and a change inside Owns that the task never asked for.',
    '',
  );

  return lines.join('\n');
}

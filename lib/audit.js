// SPDX-License-Identifier: Apache-2.0

// The facts pd-auditor works from.
//
// The auditor asks three questions: which requirements have no code, which code
// answers no requirement, and what changed outside the declared ownership. The
// third is a set difference between the diff and the Owns map — mechanical, and
// therefore not something an Opus should be spending judgement on. The first
// two are mechanical at the level of the map (a requirement with no task, a
// task with no requirement) and judgement below it (a requirement with a task
// whose code does something else). This module answers everything mechanical
// and stops exactly there.
//
// Nothing here decides. There is no verdict field, no ok flag over the whole
// report, and no state transition — a collector that graded its own findings
// would be the second opinion the audit is supposed to be getting.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { checkPlan, parsePlan, parseTask } from './artefacts.js';
import { issueDir, resolveHome } from './config.js';
import { validateReceipt } from './evidence.js';
import { matchesAny } from './globs.js';
import { changedPaths } from './repo.js';
import { read as readState } from './state.js';

/**
 * @typedef {object} TaskFacts
 * @property {string} id
 * @property {string[]} satisfies
 * @property {string[]} owns
 * @property {'ok'|'missing'|'invalid'|'failed'} receipt
 * @property {string} [receiptDetail]
 * @property {string} [command]
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

/**
 * Collect what can be established without judgement.
 *
 * @param {{issue: number, repoRoot?: string, base?: string, ref?: string, home?: string}} input
 * @returns {Promise<object>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome();
  const issue = input.issue;

  const record = await readState(issue, { home });
  const planText = await artefact(home, issue, 'plan.md');
  const plan = planText === null ? null : parsePlan(planText);

  const tasks = await taskFiles(home, issue);
  /** @type {TaskFacts[]} */
  const facts = [];

  for (const task of tasks) {
    facts.push({
      id: task.id,
      satisfies: task.satisfies,
      owns: task.owns,
      ...(await receiptFor(home, issue, task.id)),
    });
  }

  // The plan is the fallback source of tasks. A quickfix has no task files at
  // all, and an issue mid-planning may have a plan before it has them.
  if (facts.length === 0 && plan) {
    for (const task of plan.tasks) {
      facts.push({ id: task.id, satisfies: task.satisfies, owns: task.owns, ...(await receiptFor(home, issue, task.id)) });
    }
  }

  const changed = input.repoRoot
    ? await changedPaths(input.base ?? 'main', input.ref ?? 'HEAD', { cwd: input.repoRoot })
    : [];

  const owned = facts.flatMap((task) => task.owns);
  // The reason this is here rather than in the pre-write hook: the hook is
  // silent when no task was ever started, so this is the only place a file
  // written outside every Owns set is certain to be seen.
  const unowned = changed.filter((entry) => !matchesAny(entry.path, owned)).map((entry) => entry.path);

  const declared = record.requirements.ids.length ? record.requirements.ids : (plan?.requirements ?? []);
  const covered = new Set(facts.flatMap((task) => task.satisfies));

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
      base: input.base ?? 'main',
      ref: input.ref ?? 'HEAD',
      repo: input.repoRoot ?? null,
      files: changed,
    },
    unowned,
    uncovered: declared.filter((id) => !covered.has(id)),
    unsatisfying: facts.filter((task) => task.satisfies.length === 0).map((task) => task.id),
    receipts: {
      missing: facts.filter((task) => task.receipt === 'missing').map((task) => task.id),
      invalid: facts.filter((task) => task.receipt === 'invalid').map((task) => task.id),
      failed: facts.filter((task) => task.receipt === 'failed').map((task) => task.id),
    },
  };
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
    const mark = { ok: '✔', missing: '✘', invalid: '✘', failed: '✘' }[task.receipt];
    lines.push(
      `    ${mark} ${task.id}  satisfies ${task.satisfies.join(', ') || '—'}  receipt ${task.receipt}` +
        `${task.receiptDetail ? ` (${task.receiptDetail})` : ''}`,
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

  lines.push(
    '',
    '  These are facts, not a verdict. What is left is what no grep answers:',
    '  a requirement whose code does something else, code that answers nothing,',
    '  and a change inside Owns that the task never asked for.',
    '',
  );

  return lines.join('\n');
}

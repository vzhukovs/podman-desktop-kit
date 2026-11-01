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

// Reconciling an issue with its amendments: what each one ended up as, and
// what an approved one changes in the requirement set, plan.md and the task
// files.
//
// Moved out of lib/cli.js so the command dispatcher only prints. Everything
// here reads and writes through the modules that own the data — the record
// through lib/state.js, the plan and task files through lib/artefacts.js and
// lib/render.js, the journal through lib/journal.js — and returns what it did;
// the wording a person reads stays with the commands.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  addPlanTasks,
  amendmentCoverageProblems,
  amendmentTaskProblems,
  amendmentTaskValues,
  parseAmendment,
  parsePlan,
  parseTask,
  setPlanRequirements,
  setTaskStatus,
  withdrawnStatus,
} from './artefacts.js';
import { paths } from './config.js';
import * as journal from './journal.js';
import * as render from './render.js';
import * as state from './state.js';

/**
 * Every amendment of an issue, read off disk in ID order.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<Array<import('./artefacts.js').Amendment & {path: string}>>}
 */
export async function readAmendments(issue, home) {
  const dir = join(paths(home).issues, String(issue), 'amendments');
  const names = (await readdir(dir).catch(() => [])).filter((name) => /^A\d+\.md$/.test(name));

  names.sort((a, b) => Number.parseInt(a.slice(1), 10) - Number.parseInt(b.slice(1), 10));

  const found = [];
  for (const name of names) {
    const path = join(dir, name);
    found.push({ ...parseAmendment(await readFile(path, 'utf8')), path });
  }
  return found;
}

/**
 * How each amendment of an issue ended up, one line apiece, for the harvest.
 *
 * The status comes off the amendment file and not out of the journal, for the
 * reason parseAmendment gives: the file is the artefact a person opens, and it
 * is the thing `amendment approve` rewrites. `close` used to read the journal's
 * `amendment-proposed` entry instead and print its detail verbatim — a string
 * fixed at the moment of proposal, reading "awaiting approval" forever after.
 * On DESKTOP-18835 both amendments had been approved three days before the
 * close, and the only human-readable account of what happened to the plan said
 * neither of them had been.
 *
 * Who decided, and why, is the half only the journal has — the file records the
 * decision, not the deciding — so the decision entry is read for that alone.
 * Its absence is not an error: an amendment settled by a hand-edit of the file
 * has a status and no entry, and a status with nobody's name on it is still the
 * truth about the plan.
 *
 * @param {Array<import('./artefacts.js').Amendment>} amendments
 * @param {import('./journal.js').Entry[]} entries
 * @returns {string[]}
 */
export function amendmentOutcomes(amendments, entries) {
  const decided = new Map();
  for (const entry of entries) {
    if (entry.event !== 'amendment-approved' && entry.event !== 'amendment-rejected') continue;
    // The ID is the first field the decision writes and the rest is the free
    // text — who, and on a rejection why. Anchored at the start for that
    // reason: it matches the ID the command put there, never an `A1` somebody
    // typed into a reason.
    const match = /^(A\d+)(?:\s*—\s*(.*))?$/.exec(entry.detail ?? '');
    // Chronological, so a later decision overwrites an earlier one. There
    // should not be two, and if there are, the one that stands is the last.
    if (match) decided.set(match[1], (match[2] ?? '').trim());
  }

  return amendments.map((amendment) => {
    const attribution = decided.get(amendment.id);
    return `${amendment.id} — ${amendment.status || 'in no recognized status'}${attribution ? ` (${attribution})` : ''}`;
  });
}

/**
 * Bring the issue's requirement set and plan.md into line with an approved
 * amendment, and say what moved.
 *
 * Both halves, and each one reported on its own, because they fail separately:
 * the set is in state.json, which only lib/state.js writes, and the plan is a
 * file a person edits and may have moved or reworded. On 18915 A1 was approved
 * and neither half followed, and what found it twenty hours later was `slice
 * set` refusing and `pdkit audit` reporting drift.
 *
 * Nothing is applied twice: the record keeps which amendments it has taken, and
 * a plan line that already says the live set is left as it is. That is what
 * makes it safe to run again after a half-application — which is all `amendment
 * sync` is.
 *
 * @param {number} issue
 * @param {string} id
 * @param {string} home
 * @returns {Promise<{requirements: {before: string[], after: string[], added: string[], removed: string[], already: boolean, reflected: boolean}|null, plan: {path: string, before: string[], after: string[], written: boolean}|null, unreconciled: string[]}>}
 */
export async function reconcileAmendment(issue, id, home) {
  const outcome = { requirements: null, plan: null, tasks: null, unreconciled: [] };

  const applied = await state.amendRequirements(issue, { amendment: id, home });
  if (!applied.ok) {
    outcome.unreconciled.push(
      [`the requirement set in the issue record: ${applied.error}`, ...(applied.problems ?? []).map((problem) => `  ${problem}`)].join('\n      '),
    );
    return outcome;
  }

  await reconcileRequirementLine(issue, id, home, applied, outcome);
  outcome.tasks = await reconcileTasks(issue, id, home, outcome.unreconciled);

  return outcome;
}

/**
 * The requirement half of reconcileAmendment: the set it applied, and plan.md's
 * `- Requirements:` line brought into line with it.
 *
 * @param {number} issue
 * @param {string} id
 * @param {string} home
 * @param {Awaited<ReturnType<typeof state.amendRequirements>>} applied
 * @param {{requirements: object|null, plan: object|null, unreconciled: string[]}} outcome
 * @returns {Promise<void>}
 */
async function reconcileRequirementLine(issue, id, home, applied, outcome) {
  outcome.requirements = {
    before: applied.before,
    after: applied.after,
    added: applied.added,
    removed: applied.removed,
    already: Boolean(applied.already),
    reflected: Boolean(applied.reflected),
  };

  // An amendment with no requirement rows changes no set, and the plan line has
  // nothing to follow.
  const record = await state.read(issue, { home });
  const taken = record.requirements.amendments ?? [];
  if (!taken.includes(id)) return;

  const path = join(paths(home).issues, String(issue), 'plan.md');
  const live = record.requirements.ids;
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    outcome.unreconciled.push(`plan.md: there is none at ${path}, so nothing in it says ${live.join(', ')}`);
    return;
  }

  const declared = parsePlan(content).requirements;
  const rewritten = setPlanRequirements(content, live, taken);
  if (rewritten === null) {
    outcome.unreconciled.push(`plan.md: ${path} has no "- Requirements:" line, so nothing in it says ${live.join(', ')}`);
    return;
  }

  const written = rewritten !== content;
  if (written) await writeFile(path, rewritten);
  outcome.plan = { path, before: declared, after: live, written };
}

/**
 * Why an amendment's tasks cannot be made into task files, read off disk.
 *
 * Shared by approve, which asks before it writes the status, and by
 * reconcileTasks, which asks again because `sync` reaches it for amendments
 * approved before tasks were materialized at all.
 *
 * @param {number} issue
 * @param {import('./artefacts.js').Amendment} amendment
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function taskProblemsOf(issue, amendment, home) {
  if (amendment.tasks.length === 0 && amendment.unreadTasks.length === 0) return [];

  const record = await state.read(issue, { home });
  const taken = (record.requirements.amendments ?? []).includes(amendment.id);
  const after =
    taken || amendment.requirements.length === 0
      ? record.requirements.ids
      : (state.amendedRequirements(record.requirements, amendment.requirements).after ?? record.requirements.ids);

  const planText = await readFile(join(paths(home).issues, String(issue), 'plan.md'), 'utf8').catch(() => null);
  return amendmentTaskProblems({ amendment, plan: planText === null ? null : parsePlan(planText), requirements: after });
}

/**
 * The requirements an amendment would leave satisfied by no live task.
 *
 * Measured against plan.md, which is where every task an amendment writes
 * ends up. Without a plan there is nothing to measure against: an adopted or
 * quickfix issue has no task map, and saying its requirements are uncovered
 * would describe the route rather than the amendment.
 *
 * @param {number} issue
 * @param {ReturnType<typeof parseAmendment> & {path: string}} amendment
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function coverageProblemsOf(issue, amendment, home) {
  const planText = await readFile(join(paths(home).issues, String(issue), 'plan.md'), 'utf8').catch(() => null);
  if (planText === null) return [];

  const record = await state.read(issue, { home });
  if ((record.requirements.amendments ?? []).includes(amendment.id)) return [];

  const before = record.requirements.ids ?? [];
  const after =
    amendment.requirements.length === 0 ? before : (state.amendedRequirements(record.requirements, amendment.requirements).after ?? before);

  return amendmentCoverageProblems({ amendment, plan: parsePlan(planText), before, after });
}

/**
 * Make an approved amendment's tasks real: task files for the ones it writes,
 * a withdrawn status for the ones it replaces, the blocks in plan.md, and the
 * ownership map read back from the files.
 *
 * Step 5 of part 6 of specs/2026-10-18-plugin-usage-flow.md, which was a person
 * running `render task` twice and `task sync` once. On 18915 nobody did: `/pd:exec`
 * found T5 and T6 only as text in A1.md and wrote their files by hand with a
 * heredoc, while T2–T4 stayed live — the audit asked for their receipts and
 * `owns.T2` kept updater.ts, a file A1 says nobody touches.
 *
 * Every step is safe to repeat: an existing task file with the same title is
 * kept rather than re-rendered over what was written into it since, a status
 * already withdrawn is not rewritten, plan.md gains only the blocks it lacks.
 *
 * @param {number} issue
 * @param {string} id
 * @param {string} home
 * @param {string[]} unreconciled   what could not be done is appended here
 * @returns {Promise<{written: string[], kept: string[], withdrawn: Array<{task: string, replacedBy: string[], released: string[]}>, plan: string[], synced: Awaited<ReturnType<typeof syncTasks>>}|null>}
 */
async function reconcileTasks(issue, id, home, unreconciled) {
  const dir = join(paths(home).issues, String(issue));
  const amendment = parseAmendment(await readFile(join(dir, 'amendments', `${id}.md`), 'utf8'));
  if (amendment.tasks.length === 0 && amendment.unreadTasks.length === 0) return null;

  const problems = await taskProblemsOf(issue, amendment, home);
  if (problems.length > 0) {
    unreconciled.push([`the tasks in "Slices affected" were not written:`, ...problems.map((problem) => `  ${problem}`)].join('\n      '));
    return null;
  }

  const done = { written: [], kept: [], withdrawn: [], plan: [], synced: [] };

  for (const task of amendment.tasks) {
    const path = join('tasks', `${task.id}.md`);
    const existing = await readFile(join(dir, path), 'utf8').catch(() => null);
    if (existing !== null) {
      // Same check as for the plan: the title is what says it is the same task.
      // A file that is something else is not overwritten and not passed over.
      const was = parseTask(existing);
      if (was.title.trim().toLowerCase() !== task.title.trim().toLowerCase()) {
        unreconciled.push(`${path}: already there as "${was.title}", not ${id}'s "${task.title}" — left as it is`);
      } else done.kept.push(task.id);
      continue;
    }
    await render.write({ issue, template: 'task', path, values: amendmentTaskValues(task, { issue, amendment: id }), home });
    done.written.push(task.id);
  }

  /** @type {Map<string, string[]>} withdrawn task -> the tasks that replace it */
  const replaced = new Map();
  for (const task of amendment.tasks) {
    for (const old of task.replaces) replaced.set(old, [...(replaced.get(old) ?? []), task.id]);
  }

  for (const [task, replacedBy] of replaced) {
    const path = join(dir, 'tasks', `${task}.md`);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text !== null && !parseTask(text).withdrawn) {
      const rewritten = setTaskStatus(text, withdrawnStatus({ amendment: id, replacedBy }));
      if (rewritten === null) unreconciled.push(`tasks/${task}.md has no "- Status:" line to mark withdrawn`);
      else await writeFile(path, rewritten);
    }
    const result = await state.withdrawTask(issue, { task, amendment: id, replacedBy, home });
    if (result.changed) done.withdrawn.push({ task, replacedBy, released: result.owned ?? [] });
  }

  const planPath = join(dir, 'plan.md');
  const planText = await readFile(planPath, 'utf8').catch(() => null);
  if (planText !== null) {
    const added = addPlanTasks(planText, amendment.tasks);
    if (added === null) unreconciled.push(`plan.md: ${planPath} has no "## Tasks" section to add ${amendment.tasks.map((task) => task.id).join(', ')} to`);
    else if (added.added.length > 0) {
      await writeFile(planPath, added.text);
      done.plan = added.added;
    }
  }

  // The map comes from the files, as at the end of /pd:plan — not from the
  // amendment, so that what the hook enforces is what a worker is handed.
  done.synced = await syncTasks(issue, home);

  if (done.written.length + done.withdrawn.length + done.plan.length > 0) {
    await journal.append(
      {
        issue,
        event: 'amendment-tasks',
        detail: [
          id,
          done.written.length ? `wrote ${done.written.join(',')}` : '',
          done.withdrawn.length ? `withdrew ${done.withdrawn.map((entry) => entry.task).join(',')}` : '',
          done.plan.length ? `plan.md gained ${done.plan.join(',')}` : '',
        ]
          .filter(Boolean)
          .join(' — '),
      },
      { home },
    );
  }

  return done;
}

/**
 * Read every task file of an issue into the record: the Owns set of a live
 * task, the withdrawal of a withdrawn one.
 *
 * A withdrawn task's Owns section is still in its file, and still parses. Syncing
 * it as ownership is what would bring back the second claim on a file that
 * withdrawing it released.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<Array<{task: string, owns: string[], withdrawn: import('./artefacts.js').Withdrawal|null}>|null>}  null with no tasks/ directory
 */
export async function syncTasks(issue, home) {
  const dir = join(paths(home).issues, String(issue), 'tasks');
  let entries;
  try {
    entries = (await readdir(dir)).filter((name) => /^T\d+\.md$/.test(name));
  } catch {
    return null;
  }
  entries.sort((a, b) => Number.parseInt(a.slice(1), 10) - Number.parseInt(b.slice(1), 10));

  const synced = [];
  for (const entry of entries) {
    const parsed = parseTask(await readFile(join(dir, entry), 'utf8'));
    if (!parsed.id) continue;
    if (parsed.withdrawn) {
      await state.withdrawTask(issue, { task: parsed.id, amendment: parsed.withdrawn.amendment, replacedBy: parsed.withdrawn.replacedBy, home });
      synced.push({ task: parsed.id, owns: [], withdrawn: parsed.withdrawn });
      continue;
    }
    // The task file is the authority: it comes from the plan, so the hook
    // guards what was agreed rather than what somebody typed at a prompt.
    await state.setOwns(issue, parsed.id, parsed.owns, { home });
    synced.push({ task: parsed.id, owns: parsed.owns, withdrawn: null });
  }
  return synced;
}

/**
 * Say what syncTasks read, one task a line.
 *
 * @param {{task: string, owns: string[], withdrawn: import('./artefacts.js').Withdrawal|null}} entry
 * @returns {string}
 */
export function describeSynced(entry) {
  if (entry.withdrawn) return `${entry.task}  withdrawn${entry.withdrawn.amendment ? ` by ${entry.withdrawn.amendment}` : ''} — owns nothing`;
  return `${entry.task}  ${entry.owns.join(', ') || 'owns nothing'}`;
}

/**
 * Whether a task has been withdrawn, from the record or from its own file.
 *
 * Both, because they are written apart: the file can be marked by hand before
 * anyone runs `task sync`, and the record can hold a task whose file was never
 * rendered. Either one is enough to refuse work on it.
 *
 * @param {number} issue
 * @param {string} taskId
 * @param {string} home
 * @returns {Promise<{amendment: string|null, replacedBy: string[]}|null>}
 */
export async function withdrawalFor(issue, taskId, home) {
  const record = await state.read(issue, { home });
  if (record.withdrawn?.[taskId]) return record.withdrawn[taskId];

  const text = await readFile(join(paths(home).issues, String(issue), 'tasks', `${taskId}.md`), 'utf8').catch(() => null);
  return text === null ? null : parseTask(text).withdrawn;
}

/**
 * The refusal for work on a withdrawn task.
 *
 * @param {string} command
 * @param {number} issue
 * @param {string} taskId
 * @param {{amendment: string|null, replacedBy: string[]}} withdrawal
 * @returns {string}
 */
export function withdrawnMessage(command, issue, taskId, withdrawal) {
  const by = withdrawal.amendment ? ` by ${withdrawal.amendment}` : '';
  const instead = withdrawal.replacedBy.length > 0 ? ` Its work is ${withdrawal.replacedBy.join(', ')} now.` : '';
  const where = withdrawal.amendment ? ` (amendments/${withdrawal.amendment}.md)` : '';
  return `pdkit ${command}: ${taskId} of issue ${issue} was withdrawn${by}${where} and is not part of the plan.${instead}\n`;
}

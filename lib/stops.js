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

// Stop reports: why a task stopped on the plan rather than on the code, and
// whether anything has settled it.
//
// The exec skill has always said "stop, report, amend", and nothing held the
// report. On a multi-slice issue five tasks stopped across two sessions; each
// finding went into a session's scratch directory, which nothing else reads and
// which does not outlive the session. The person asked what the amendment should
// contain and was told the format was unknown. The amendment that followed was
// written from the reviewing session's own context, fixed one task, and left a
// second task running the same broken command — which then stopped too.
//
// So a stop is an artefact under the issue, `stops/<task>-<k>.md`, in one shape:
// what is wrong, the evidence, what else it reaches, what a person must decide,
// and what the amendment should change. Whether it is still open is DERIVED, not
// stored: from the record's withdrawals (every task it names replaced) and from
// the journal (a person cleared it), for the reasons lib/attempts.js gives — a
// stored copy is a second source of truth.
//
// The one mechanical check here is the one that was missed: other live tasks
// whose `Done when` runs the same command, or which own a file the report names.
// Whether the cause really reaches them is judgment, so a task found that way
// may be named under `affects` or excused under `unaffected` with a sentence;
// what it may not be is ignored.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import * as journal from './journal.js';
import * as render from './render.js';
import * as state from './state.js';

/** Journal events this module writes and reads. A closed vocabulary. */
export const EVENTS = {
  stopped: 'task-stop-report',
  cleared: 'stop-report-cleared',
};

/** `T11-1`: the task the report is about, and which of its reports this is. */
export const STOP_ID = /^(T\d+)-(\d+)$/;

/** What a report must say. `command`, `files`, `affects` and `unaffected` are optional. */
export const REQUIRED = ['wrong', 'evidence', 'decision', 'proposal'];

/**
 * The values file `pdkit task stop --finding` reads.
 *
 * @typedef {object} StopValues
 * @property {string} wrong
 * @property {string} evidence
 * @property {string} decision
 * @property {string} proposal
 * @property {string} [command]    the command that fails, as it appears in `Done when`
 * @property {string[]} [files]    repository paths the finding is about
 * @property {string[]} [affects]  other tasks the same cause reaches
 * @property {Record<string, string>} [unaffected]  task -> why the cause does not reach it
 */

/**
 * A stop report as read back from disk.
 *
 * @typedef {object} StopReport
 * @property {string} id
 * @property {string} task
 * @property {string[]} affects
 * @property {string[]} names      the task and everything it affects
 * @property {string|null} command
 * @property {string} wrong        the first line of "What is wrong"
 * @property {string} path
 * @property {'open'|'resolved'|'cleared'} status
 * @property {string[]} resolvedBy the amendments that withdrew the tasks it names
 * @property {string|null} clearedBecause
 */

/**
 * Why a values file cannot become a report, if anything.
 *
 * Pure. `plan` is the parsed plan and `withdrawn` the record's withdrawals, so
 * "live" means what it means to `plan check`.
 *
 * @param {StopValues} values
 * @param {{taskId: string, plan: import('./artefacts.js').Plan|null, withdrawn?: Record<string, unknown>}} context
 * @returns {string[]}
 */
export function problemsOf(values, context) {
  const problems = [];
  const given = values ?? {};

  for (const name of REQUIRED) {
    if (typeof given[name] !== 'string' || given[name].trim() === '') problems.push(`"${name}" is empty — ${describe(name)}`);
  }
  for (const name of ['affects', 'files']) {
    if (given[name] !== undefined && !Array.isArray(given[name])) problems.push(`"${name}" is a list`);
  }
  if (given.unaffected !== undefined && (typeof given.unaffected !== 'object' || given.unaffected === null || Array.isArray(given.unaffected))) {
    problems.push('"unaffected" is an object: {"T16": "why the cause does not reach it"}');
  }
  if (problems.length > 0 || !context.plan) return problems;

  const withdrawn = context.withdrawn ?? {};
  const tasks = context.plan.tasks;
  const live = tasks.filter((task) => !task.replacedBy && !(task.id in withdrawn));
  const known = new Set(tasks.map((task) => task.id));

  if (!known.has(context.taskId)) problems.push(`${context.taskId} is not a task in plan.md`);

  const affects = new Set(given.affects ?? []);
  const excused = new Set(Object.keys(given.unaffected ?? {}));
  for (const id of affects) {
    if (!known.has(id)) problems.push(`"affects" names ${id}, which plan.md does not have`);
    else if (!live.some((task) => task.id === id)) problems.push(`"affects" names ${id}, which is withdrawn — name what replaced it`);
  }
  for (const [id, why] of Object.entries(given.unaffected ?? {})) {
    if (typeof why !== 'string' || why.trim() === '') problems.push(`"unaffected" excuses ${id} without saying why`);
  }

  for (const reach of reachOf(given, live, context.taskId)) {
    if (affects.has(reach.task) || excused.has(reach.task)) continue;
    problems.push(
      `${reach.task} ${reach.because} — name it under "affects", or say under "unaffected" why the cause does not reach it`,
    );
  }

  return problems;
}

/**
 * The other live tasks the report's command or files reach, and how.
 *
 * Substring rather than equality for the command, because a `Done when` chains
 * commands with `&&`: the one that failed is a part of it, and that part is
 * what another task's chain shares.
 *
 * @param {StopValues} values
 * @param {import('./artefacts.js').PlanTask[]} live
 * @param {string} taskId
 * @returns {Array<{task: string, because: string}>}
 */
export function reachOf(values, live, taskId) {
  const command = typeof values.command === 'string' ? values.command.trim() : '';
  const files = (values.files ?? []).map((file) => String(file).trim()).filter(Boolean);
  const found = [];

  for (const task of live) {
    if (task.id === taskId) continue;
    if (command && task.command && task.command.includes(command)) {
      found.push({ task: task.id, because: `runs the same command in its Done when (\`${command}\`)` });
      continue;
    }
    const shared = files.filter((file) => task.owns.includes(file));
    if (shared.length > 0) found.push({ task: task.id, because: `owns ${shared.join(', ')}` });
  }

  return found;
}

/**
 * What each required field is for, in the refusal that finds it empty.
 *
 * @param {string} name
 * @returns {string}
 */
function describe(name) {
  return {
    wrong: 'the defect in the plan, with file:line',
    evidence: 'the command that shows it and what it printed',
    decision: 'what only a person can decide, or "—"',
    proposal: 'what the amendment should change, per task',
  }[name];
}

/**
 * Every stop report of an issue, with whether it is still open.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<StopReport[]>}
 */
export async function read(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const dir = join(issueDir(home, issue), 'stops');
  const names = (await readdir(dir).catch(() => [])).filter((name) => /^T\d+-\d+\.md$/.test(name));
  names.sort(byId);

  const record = await state.read(issue, { home });
  const withdrawn = record.withdrawn ?? {};
  const cleared = new Map();
  for (const entry of await journal.read({ issue, event: EVENTS.cleared }, { home }).catch(() => [])) {
    const match = /^(T\d+-\d+)(?:\s*—\s*(.*))?$/.exec(entry.detail ?? '');
    if (match) cleared.set(match[1], (match[2] ?? '').trim());
  }

  const reports = [];
  for (const name of names) {
    const path = join(dir, name);
    const parsed = parse(await readFile(path, 'utf8'));
    const id = name.replace(/\.md$/, '');
    const named = [parsed.task || id.split('-')[0], ...parsed.affects.filter((task) => task !== parsed.task)];
    const resolvedBy = [...new Set(named.map((task) => withdrawn[task]?.amendment).filter(Boolean))];
    const allWithdrawn = named.every((task) => task in withdrawn);

    reports.push({
      id,
      task: named[0],
      affects: parsed.affects,
      names: named,
      command: parsed.command,
      wrong: parsed.wrong,
      path,
      status: cleared.has(id) ? 'cleared' : allWithdrawn ? 'resolved' : 'open',
      resolvedBy,
      clearedBecause: cleared.get(id) ?? null,
    });
  }
  return reports;
}

/**
 * Read a report's header and first line of "What is wrong".
 *
 * @param {string} text
 * @returns {{task: string, affects: string[], command: string|null, wrong: string}}
 */
export function parse(text) {
  const clean = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const task = /^-[ \t]*Task:[ \t]*(T\d+)/m.exec(clean);
  const affects = /^-[ \t]*Affects:[ \t]*(.*)$/m.exec(clean);
  const command = /^-[ \t]*Command:[ \t]*`([^`]+)`/m.exec(clean);
  const wrong = /^##[ \t]+What is wrong[ \t]*\n+([^\n]+)/m.exec(clean);

  return {
    task: task ? task[1] : '',
    affects: affects ? [...new Set(affects[1].match(/\bT\d+\b/g) ?? [])] : [],
    command: command ? command[1] : null,
    wrong: wrong ? wrong[1].trim() : '',
  };
}

/**
 * Write a stop report and record it in the journal.
 *
 * The caller has checked the values with problemsOf; this allocates the next
 * number for the task and renders. The number comes from the directory, not a
 * counter: a report belongs to its task, and `T11-2` says it is the second time
 * T11 stopped on the plan, which a global counter would not.
 *
 * @param {{issue: number, taskId: string, values: StopValues, home?: string}} input
 * @returns {Promise<{id: string, path: string}>}
 */
export async function write(input) {
  const home = input.home ?? resolveHome();
  const dir = join(issueDir(home, input.issue), 'stops');
  const taken = (await readdir(dir).catch(() => []))
    .map((name) => STOP_ID.exec(name.replace(/\.md$/, '')))
    .filter((match) => match && match[1] === input.taskId)
    .map((match) => Number.parseInt(match[2], 10));
  const id = `${input.taskId}-${Math.max(0, ...taken) + 1}`;

  const values = input.values;
  const affects = (values.affects ?? []).filter((task) => task !== input.taskId);
  const unaffected = Object.entries(values.unaffected ?? {}).map(([task, why]) => `- ${task}: ${String(why).trim()}`);

  const path = await render.write({
    issue: input.issue,
    template: 'stopReport',
    path: join('stops', `${id}.md`),
    home,
    values: {
      id,
      issue: input.issue,
      taskId: input.taskId,
      affects: affects.join(', ') || '—',
      date: new Date().toISOString().slice(0, 10),
      command: values.command ? `\`${values.command.trim()}\`` : '—',
      wrong: values.wrong.trim(),
      evidence: values.evidence.trim(),
      unaffected: unaffected.length > 0 ? unaffected : '—',
      decision: values.decision.trim(),
      proposal: values.proposal.trim(),
    },
  });

  await journal.append(
    { issue: input.issue, event: EVENTS.stopped, detail: `${id} ${input.taskId}${affects.length ? ` — affects ${affects.join(',')}` : ''}` },
    { home },
  );
  return { id, path };
}

/**
 * Set a report aside without an amendment: the plan turned out right, or the
 * cause was the environment. The reason is a sentence a person writes, for the
 * reason `task unblock` asks for one.
 *
 * @param {{issue: number, id: string, reason: string, home?: string}} input
 * @returns {Promise<void>}
 */
export async function clear(input) {
  await journal.append(
    { issue: input.issue, event: EVENTS.cleared, detail: `${input.id} — ${input.reason}` },
    { home: input.home ?? resolveHome() },
  );
}

/**
 * Why an amendment would leave a stop report half settled.
 *
 * A report the amendment touches — it replaces at least one task the report
 * names — has to come out of it settled: every task the report names replaced
 * by this amendment or already withdrawn. Otherwise the amendment fixes the
 * stopped task and leaves its neighbor running the same cause, which is how a
 * third amendment came to be needed for one finding.
 *
 * Pure.
 *
 * @param {{amendment: import('./artefacts.js').Amendment, reports: StopReport[], withdrawn?: Record<string, unknown>}} input
 * @returns {string[]}
 */
export function amendmentProblems(input) {
  const replaced = new Set(input.amendment.tasks.flatMap((task) => task.replaces));
  const withdrawn = input.withdrawn ?? {};
  const problems = [];

  for (const report of input.reports) {
    if (report.status !== 'open') continue;
    if (!report.names.some((task) => replaced.has(task))) continue;

    const left = report.names.filter((task) => !replaced.has(task) && !(task in withdrawn));
    if (left.length > 0) {
      problems.push(
        `stop report ${report.id} names ${left.join(', ')} as well, and ${input.amendment.id} leaves ${left.length === 1 ? 'it' : 'them'} as ${left.length === 1 ? 'it is' : 'they are'} — ` +
          `replace ${left.length === 1 ? 'it' : 'them'} too (stops/${report.id}.md says what changes). If the cause does not reach ${left.length === 1 ? 'it' : 'them'} after all, ` +
          `correct "Affects" in the report, or set the report aside with \`pdkit task clear --issue <n> --report ${report.id} --reason <why>\``,
      );
    }
  }
  return problems;
}

/**
 * Order `T2-1.md` before `T10-1.md`, and `T11-2.md` after `T11-1.md`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byId(a, b) {
  const [, ta, ka] = /^T(\d+)-(\d+)/.exec(a);
  const [, tb, kb] = /^T(\d+)-(\d+)/.exec(b);
  return Number(ta) - Number(tb) || Number(ka) - Number(kb);
}

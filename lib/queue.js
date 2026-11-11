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

// The task queue of an issue: where each task stands, what each one waits for,
// and which one runs next.
//
// Every exec session used to rebuild this from `git log`, the receipts and its
// own memory, and each one worded it differently — and chose the next task
// differently, which is how a plan's first task ran fourth. Nothing here is
// stored. Each fact comes from the module that owns it: the order from the
// plan's `After` lines and block positions (artefacts.taskOrder), done from the
// receipt (evidence.receiptState), blocked from the attempt count, running from
// the active pointers, stopped from the stop reports.
//
// "Done" means a receipt that validates and exited 0. Whether the work was
// committed is not measured here, and the status does not claim it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as active from './active.js';
import { parsePlan, taskOrder } from './artefacts.js';
import * as attempts from './attempts.js';
import { issueDir, resolveHome } from './config.js';
import { receiptState } from './evidence.js';
import * as state from './state.js';
import * as stops from './stops.js';

/**
 * The statuses, in the order they win: a task a stop report names is stopped
 * even with a green receipt, because the report says the receipt proves the
 * wrong thing.
 */
export const STATUSES = ['withdrawn', 'running', 'stopped', 'blocked', 'done', 'waiting', 'ready'];

/**
 * One task of the queue.
 *
 * @typedef {object} QueueEntry
 * @property {string} id
 * @property {string} title
 * @property {string|null} slice
 * @property {'withdrawn'|'running'|'stopped'|'blocked'|'done'|'waiting'|'ready'} status
 * @property {string[]} after          the live tasks it waits for, resolved through replacements
 * @property {string[]} waitingOn      those of them not done yet
 * @property {string} receipt          ok | missing | invalid | failed
 * @property {string|null} receiptDetail
 * @property {string[]} stops          open stop reports naming it
 * @property {string[]} replacedBy     for a withdrawn task
 * @property {string|null} amendment   the amendment that withdrew it
 * @property {{attempts: number, max: number}|null} attempts
 */

/**
 * The queue, from a plan already read and facts already gathered.
 *
 * Pure, so the order and the statuses can be tested without a journal.
 *
 * @param {{
 *   plan: import('./artefacts.js').Plan,
 *   withdrawn?: Record<string, {amendment?: string|null, replacedBy?: string[]}>,
 *   receipts: Map<string, {receipt: string, receiptDetail?: string}>,
 *   running?: string[],
 *   blocked?: Map<string, {attempts: number, max: number}>,
 *   reports?: import('./stops.js').StopReport[],
 * }} input
 * @returns {{tasks: QueueEntry[], next: string|null, problems: string[]}}
 */
export function build(input) {
  const withdrawn = input.withdrawn ?? {};
  const { order, dependsOn, problems } = taskOrder(input.plan.tasks, withdrawn);
  const byId = new Map(input.plan.tasks.map((task) => [task.id, task]));
  const running = new Set(input.running ?? []);
  const open = (input.reports ?? []).filter((report) => report.status === 'open');

  const receipt = (id) => input.receipts.get(id) ?? { receipt: 'missing' };
  const isDone = (id) => receipt(id).receipt === 'ok' && !open.some((report) => report.names.includes(id)) && !running.has(id);

  /** @type {QueueEntry[]} */
  const tasks = order.map((id) => {
    const task = byId.get(id);
    const after = dependsOn.get(id) ?? [];
    const waitingOn = after.filter((need) => !isDone(need));
    const reports = open.filter((report) => report.names.includes(id)).map((report) => report.id);
    const tried = input.blocked?.get(id) ?? null;
    const held = receipt(id);

    let status;
    if (running.has(id)) status = 'running';
    else if (reports.length > 0) status = 'stopped';
    else if (held.receipt === 'ok') status = 'done';
    else if (tried) status = 'blocked';
    else if (waitingOn.length > 0) status = 'waiting';
    else status = 'ready';

    return {
      id,
      title: task.title,
      slice: task.slice,
      status,
      after,
      waitingOn,
      receipt: held.receipt,
      receiptDetail: held.receiptDetail ?? null,
      stops: reports,
      replacedBy: [],
      amendment: null,
      attempts: tried,
    };
  });

  for (const task of input.plan.tasks) {
    if (order.includes(task.id)) continue;
    const held = withdrawn[task.id];
    tasks.push({
      id: task.id,
      title: task.title,
      slice: task.slice,
      status: 'withdrawn',
      after: [],
      waitingOn: [],
      receipt: receipt(task.id).receipt,
      receiptDetail: null,
      stops: [],
      replacedBy: held?.replacedBy?.length ? held.replacedBy : task.replacedBy ? [task.replacedBy] : [],
      amendment: held?.amendment ?? null,
      attempts: null,
    });
  }

  return {
    tasks,
    next: tasks.find((task) => task.status === 'ready')?.id ?? null,
    problems: problems.map((problem) => problem.detail),
  };
}

/**
 * The queue of an issue, read from disk.
 *
 * @param {{issue: number, config?: object, home?: string}} input
 * @returns {Promise<({found: true} & ReturnType<typeof build>) | {found: false, reason: string}>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome();
  const dir = issueDir(home, input.issue);

  const text = await readFile(join(dir, 'plan.md'), 'utf8').catch(() => null);
  if (text === null) return { found: false, reason: `issue ${input.issue} has no plan.md` };
  const plan = parsePlan(text);

  const record = await state.read(input.issue, { home });

  const receipts = new Map();
  for (const task of plan.tasks) {
    const content = await readFile(join(dir, 'receipts', `${task.id}.md`), 'utf8').catch(() => null);
    receipts.set(task.id, receiptState(content));
  }

  const blocked = new Map();
  for (const entry of await attempts.all({ issue: input.issue, config: input.config ?? {}, home })) {
    if (entry.blocked) blocked.set(entry.taskId, { attempts: entry.attempts, max: entry.max });
  }

  const running = (await active.list({ home })).filter((entry) => entry.issue === input.issue).map((entry) => entry.taskId);
  const reports = await stops.read(input.issue, { home });

  return { found: true, ...build({ plan, withdrawn: record.withdrawn ?? {}, receipts, running, blocked, reports }) };
}

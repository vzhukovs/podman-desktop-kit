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

// SessionStart and PreCompact handler.
//
// Both events answer the same question — "what was I doing?" — at opposite
// ends. SessionStart injects the answer; PreCompact writes it down before
// compaction can take it away. One module, branching on the event.
//
// The injected summary is deliberately small: active issue, state, next step.
// Injecting the journal itself would grow month over month until it consumed
// the context it exists to restore.

import { current } from '../active.js';
import { parseTask } from '../artefacts.js';
import { blockedMessage, status as attempts } from '../attempts.js';
import { issueDir, load, resolveHome } from '../config.js';
import { revokeAll } from '../gate.js';
import { append as appendJournal, reanchor } from '../journal.js';
import { TRANSITIONS, nextStep, read as readState } from '../state.js';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Answer "what was I doing?" — by injecting it at the start, or writing it down
 * before compaction takes it away.
 *
 * Both events are served here because they are the same question at opposite
 * ends, and two modules would drift on what the answer contains. Never blocks:
 * there is nothing here worth stopping a session over.
 *
 * @param {object|null} payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision & {message?: string}>}
 */
export async function handle(payload, context) {
  const home = resolveHome();
  const active = await current({ cwd: payload?.cwd });

  if (context.event === 'pre-compact') {
    if (!active) return { block: false };

    const record = await readState(active.issue, { home });
    await appendJournal(
      {
        issue: active.issue,
        event: 'compact',
        detail: `${active.taskId} active, issue ${record.state}${record.route ? ` (${record.route})` : ''}`,
      },
      { home },
    );

    // Nothing injected: the point of the entry is that it survives compaction,
    // and a message here would be the first thing compaction discards.
    return { block: false };
  }

  // A consent token must not outlive the session it was granted in. The TTL
  // says so already; this is what makes it true after a crash, when nobody
  // reached `gate close`.
  await revokeAll({ home });

  // No active task means no summary at all. An empty session should not open
  // with plugin noise — the first thing a user reads sets what they skip.
  if (!active) return { block: false };

  const record = await readState(active.issue, { home });
  const lines = [
    `pdkit: issue ${active.issue} — ${record.state}${record.route ? `, ${record.route}` : ''}`,
    `  task    : ${active.taskId}${await titleOf(home, active)} (${active.worktree})`,
  ];

  const owns = record.owns?.[active.taskId];
  if (owns?.length) lines.push(`  owns    : ${owns.join(', ')}`);

  // The one line that has to survive a restart. A fresh session is exactly
  // where a blocked task gets picked up and tried a fourth time, because the
  // three failures are in the context that just went away.
  const tried = await attempts({ issue: active.issue, taskId: active.taskId, config: await load({}), home });
  if (tried.attempts > 0) {
    lines.push(`  tried   : ${tried.attempts}${tried.max > 0 ? ` of ${tried.max}` : ''} failed capture(s)${tried.blocked ? ' — BLOCKED, see below' : ''}`);
  }

  const next = TRANSITIONS[record.state] ?? [];
  lines.push(`  next    : ${next.length ? next.join(', ') : 'nothing — this state is terminal'}`);

  // The summary that restores a session has to name a command, not only a
  // state. This line used to end at `next: implemented`, and a state name in
  // the position where a next action belongs is one a model will type: on
  // DESKTOP-18832 it produced `/pd:implement`, which is not a command.
  const step = nextStep(record);
  if (step) lines.push(`  run     : ${step}`);

  const history = await reanchor(active.issue, { home });
  if (history) lines.push('  recent  :', ...history.split('\n').map((entry) => `    ${entry}`));

  if (tried.blocked) lines.push('', blockedMessage({ issue: active.issue }, tried));

  return { block: false, message: lines.join('\n') };
}

/**
 * The task's title, when its file can be read. Best effort on purpose: a
 * missing task file is worth neither a failure nor a line of apology in the
 * summary, since everything else in it is still true.
 *
 * @param {string} home
 * @param {{issue: number, taskId: string}} active
 * @returns {Promise<string>}
 */
async function titleOf(home, active) {
  try {
    const text = await readFile(join(issueDir(home, active.issue), 'tasks', `${active.taskId}.md`), 'utf8');
    const task = parseTask(text);
    return task.title ? ` (${task.title})` : '';
  } catch {
    return '';
  }
}

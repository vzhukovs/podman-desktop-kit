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
//
// That smallness is what makes a session per phase affordable. Context is
// re-read whole on every call, so a session costs the square of its length,
// and one that carries an issue from triage to merge pays for the triage on
// every turn of pr-sync. A restart costs this summary: a dozen lines.

import { current } from '../active.js';
import { parseTask } from '../artefacts.js';
import { blockedMessage, status as attempts } from '../attempts.js';
import { get, issueDir, load, paths, resolveHome } from '../config.js';
import { revokeAll } from '../gate.js';
import { parseBranch } from '../ids.js';
import { append as appendJournal, reanchor } from '../journal.js';
import { currentBranch } from '../repo.js';
import { skillModel } from '../session-model.js';
import { TRANSITIONS, nextSkill, nextStep, read as readState } from '../state.js';
import { forIssue } from '../worktree.js';

import { readFile, readdir } from 'node:fs/promises';
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

  if (!active) return betweenPhases(payload?.cwd, home);

  const record = await readState(active.issue, { home });
  const lines = [
    `pdkit: issue ${active.issue} — ${record.state}${record.route ? `, ${record.route}` : ''}`,
    `  task    : ${active.taskId}${await titleOf(home, active)} (${active.worktree})`,
  ];

  // The pointer says which issue's task runs here; the branch says which
  // issue's work the tree holds. They are written by different commands, and
  // when they disagree neither is the answer — saying which is which is.
  const branch = await currentBranch({ cwd: active.worktree });
  const named = parseBranch(branch ?? '')?.issue ?? null;
  const split = named !== null && named !== active.issue;
  if (split) lines.push(`  branch  : ${branch}, which is issue ${named}'s — the task running here is ${active.issue}'s`);

  const owns = record.owns?.[active.taskId];
  if (owns?.length) lines.push(`  owns    : ${owns.join(', ')}`);
  // Restoring a session onto a verification task, the restored summary has to
  // say which kind of empty this is: the hook refuses every write for it.
  else if (Array.isArray(owns)) lines.push('  owns    : nothing — a verification task, so writes are refused');

  // The one line that has to survive a restart. A fresh session is exactly
  // where a blocked task gets picked up and tried a fourth time, because the
  // three failures are in the context that just went away.
  const tried = await attempts({ issue: active.issue, taskId: active.taskId, config: await load({}), home });
  if (tried.attempts > 0) {
    lines.push(`  tried   : ${tried.attempts}${tried.max > 0 ? ` of ${tried.max}` : ''} failed capture(s)${tried.blocked ? ' — BLOCKED, see below' : ''}`);
  }

  const next = TRANSITIONS[record.state] ?? [];
  lines.push(`  next    : ${next.length ? next.join(', ') : 'nothing — this state is terminal'}`);

  // Starting the task is itself a move on the issue, and the latest one an exec
  // session has: state.json is not written between `task start` and the receipt.
  const since = [record.updatedAt, active.startedAt].filter(Boolean).sort().at(-1) ?? null;
  const moved = await elsewhere({ issue: active.issue, since, cwd: active.worktree, home });
  lines.push(...moved);

  // The summary that restores a session has to name a command, not only a
  // state. This line used to end at `next: implemented`, and a state name in
  // the position where a next action belongs is one a model will type: on
  // DESKTOP-18832 it produced `/pd:implement`, which is not a command.
  //
  // Unless the tree is not the whole answer. Then the command, the model, the
  // budget and the story are all another issue's for as many sessions as were
  // not opened for it, and a model reads them as the session's purpose.
  if (split || moved.length) {
    lines.push(UNNAMED);
  } else {
    const step = nextStep(record);
    lines.push(...(await modelFor(record)));
    if (step) lines.push(`  run     : ${step}`);
    lines.push(...(await budgetFor(step)));

    const history = await reanchor(active.issue, { home });
    if (history) lines.push('  recent  :', ...history.split('\n').map((entry) => `    ${entry}`));
  }

  if (tried.blocked) lines.push('', blockedMessage({ issue: active.issue }, tried));

  return { block: false, message: lines.join('\n') };
}

/**
 * The summary for a tree with no task running in it — which is every phase
 * boundary but the ones inside exec.
 *
 * A task pointer only exists between `task start` and `task stop`. Read alone,
 * it left the summary empty exactly where a session per phase needs it: after
 * triage, plan, validate, audit, slice, preflight and pr. The branch says which
 * issue the tree is for, in the one shape preflight and the gate already hold it
 * to, so that is what is read.
 *
 * Still nothing for a tree on any other branch, for an issue nothing has been
 * recorded about, or for a terminal one. An empty session should not open with
 * plugin noise — the first thing a user reads sets what they skip — and a
 * merged issue's worktree is not a reason to talk.
 *
 * The branch is a witness, not the answer. Nothing returns a checkout to where
 * it was, and SessionStart fires before the prompt that says what the session
 * is for, so the branch is wherever the last piece of work left it. Every
 * session DESKTOP-18915 opened after plan-approved started in the main
 * checkout, on DESKTOP-18967/1-fix-main-event-stream-reconnect, and was told
 * 18967's state, 18967's journal and `run: /pd:pr-status` — and the first
 * answer of the session took `/pd:preflight 18915` for a typo. So when the
 * records show another issue moved after this one, the summary says so, with
 * where each tree is, and names no command.
 *
 * @param {string|undefined} cwd
 * @param {string} home
 * @returns {Promise<import('./dispatch.js').Decision & {message?: string}>}
 */
async function betweenPhases(cwd, home) {
  const branch = parseBranch((await currentBranch({ cwd })) ?? '');
  if (!branch) return { block: false };

  const record = await readState(branch.issue, { home });
  const next = TRANSITIONS[record.state] ?? [];
  if (!record.createdAt || next.length === 0) return { block: false };

  const moved = await elsewhere({ issue: branch.issue, since: record.updatedAt, cwd, home });
  if (moved.length) {
    const tree = await forIssue({ issue: branch.issue, cwd: cwd ?? process.cwd() });
    const lines = [
      `pdkit: this tree is issue ${branch.issue}'s — ${record.state}${record.route ? `, ${record.route}` : ''}`,
      `  tree    : ${tree.here.path} on ${tree.here.branch}`,
      '  task    : none running',
      `  next    : ${next.join(', ')}`,
      ...moved,
      UNNAMED,
    ];
    return { block: false, message: lines.join('\n') };
  }

  const lines = [
    `pdkit: issue ${branch.issue} — ${record.state}${record.route ? `, ${record.route}` : ''}`,
    '  task    : none running',
    `  next    : ${next.join(', ')}`,
  ];
  const step = nextStep(record);
  lines.push(...(await modelFor(record)));
  if (step) lines.push(`  run     : ${step}`);
  lines.push(...(await budgetFor(step)));

  const history = await reanchor(branch.issue, { home });
  if (history) lines.push('  recent  :', ...history.split('\n').map((entry) => `    ${entry}`));

  return { block: false, message: lines.join('\n') };
}

/**
 * What stands in for `run` when the tree is not the whole answer.
 *
 * Silence would leave the reader to fill the gap with the issue in the header;
 * this line says the gap is deliberate and where the answer is.
 */
const UNNAMED =
  '  run     : not named — this tree may not be what the session is for. `pdkit next <issue>` for the issue you came for, and work on it from its own tree';

/** How many other issues the summary lists before it only counts them. */
const ELSEWHERE_LIMIT = 4;

/**
 * Other issues in progress that were moved after this tree's issue, as summary
 * lines, or none.
 *
 * "Moved" is state.json's `updatedAt`: only commands that change an issue's
 * record write it, so it is a fact about where work happened rather than about
 * which shell was open. The journal is not used for this: `agent-done` is
 * attributed by the tree a subagent stops in, which is the very guess under
 * question, and on DESKTOP-18915 it kept stamping 18967 all afternoon.
 *
 * Read, not written. A focus pointer that commands keep up to date would be one
 * more pointer nobody returns — the defect here — and one per $PDKIT_HOME
 * cannot be right for two sessions in two worktrees at once.
 *
 * Issues moved before this one are left out: a record left at pr-open in
 * August is not what a session opened today is for, and listing every one of
 * them would teach the reader to skip the line.
 *
 * @param {{issue: number, since: string|null, cwd: string|undefined, home: string}} input
 * @returns {Promise<string[]>}
 */
async function elsewhere(input) {
  if (!input.since) return [];

  let entries;
  try {
    entries = await readdir(paths(input.home).issues);
  } catch {
    return [];
  }

  const later = [];
  for (const entry of entries) {
    const issue = Number.parseInt(entry, 10);
    if (!Number.isInteger(issue) || issue === input.issue) continue;

    let record;
    try {
      record = await readState(issue, { home: input.home });
    } catch {
      // A record that does not parse is doctor's to report; here it is just
      // not evidence of anything.
      continue;
    }
    if (!record.createdAt || (TRANSITIONS[record.state] ?? []).length === 0) continue;
    if (!record.updatedAt || record.updatedAt <= input.since) continue;
    later.push(record);
  }
  if (later.length === 0) return [];

  later.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

  const lines = [`  moved   : after ${input.issue} was, and this session may be for one of them:`];
  for (const record of later.slice(0, ELSEWHERE_LIMIT)) {
    const at = String(record.updatedAt).slice(0, 16).replace('T', ' ');
    lines.push(`    ${record.issue} — ${record.state}, moved ${at}, ${await whereIs(record.issue, input.cwd)}`);
  }
  if (later.length > ELSEWHERE_LIMIT) lines.push(`    and ${later.length - ELSEWHERE_LIMIT} more`);

  return lines;
}

/**
 * Where an issue's work is, in a few words, by the resolver commands are held
 * to — so the summary and a refusal from `pdkit preflight` name the same tree.
 *
 * @param {number} issue
 * @param {string|undefined} cwd
 * @returns {Promise<string>}
 */
async function whereIs(issue, cwd) {
  const tree = await forIssue({ issue, cwd: cwd ?? process.cwd() });
  if (tree.verdict === 'ours') return 'this tree';
  if (tree.home?.source === 'worktree') return `tree ${tree.home.path} on ${tree.home.branch ?? 'a detached HEAD'}`;
  if (tree.home?.source === 'branch') return `branch ${tree.home.branch}, checked out nowhere`;
  return `no tree or DESKTOP-${issue}/… branch names it`;
}

/**
 * The model the next phase's skill declares, as a summary line, or none.
 *
 * Before `run` because it is typed first. Read from the skill's frontmatter —
 * the one place the model is set — and shown because that setting lasts only
 * one turn; the explanation is `pdkit next`'s, not repeated here. Nothing checks
 * which model the session is on.
 *
 * @param {import('../state.js').Record_} record
 * @returns {Promise<string[]>}
 */
async function modelFor(record) {
  const skill = nextSkill(record);
  const model = skill ? await skillModel(skill) : null;
  return model ? [`  model   : /model ${model}`] : [];
}

/**
 * The turn budget for the phase a step starts, as a summary line, or none.
 *
 * Printed here because this is the one place every phase passes through at its
 * start, and a ceiling the skill has to go and look up is one it will not. It
 * stays a guide: nothing counts the turns, and the line says so rather than
 * implying a limit somebody enforces.
 *
 * @param {string|null} step
 * @returns {Promise<string[]>}
 */
async function budgetFor(step) {
  const skill = step?.match(/^\/pd:([a-z-]+)/)?.[1];
  if (!skill) return [];

  const key = skill === 'exec' ? 'exec_per_task' : skill.replace(/-/g, '_');
  const turns = get(await load({}), `budget.turns.${key}`);
  if (typeof turns !== 'number' || turns <= 0) return [];

  return [`  budget  : about ${turns} turns${skill === 'exec' ? ' per task' : ''}, then a fresh session — a guide, nothing counts them`];
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

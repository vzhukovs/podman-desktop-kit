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

// The brief a plan critic starts from: the facts of one review round,
// rendered into templates/critic-brief.md.
//
// Composed by hand each round, the critic's prompt varied in what it happened
// to mention, and what the critic found followed it: a hint toward one area
// found things there, a request to converge found nothing. Most of that prompt
// was the same facts every time — where the plan and the code are, what the
// mechanical check said, what earlier rounds decided, the shape of the report
// — and facts are what a module can hold. Where to look is the critic's own
// checklist, in agents/pd-plan-critic.md, and nothing here adds to it.
//
// The scope is the whole plan, the tasks of some of its areas (lib/plan-areas.js),
// or one axis across the whole plan: a large plan is split between critics
// because one critic's context does not hold it. A scoped brief lists its tasks
// with the edges that leave the scope, so the critic sees what waits on its
// tasks elsewhere. Every brief ends the report with a coverage map, so what was
// not checked is said in the report rather than left for a later round to find.
//
// A delta round reviews what changed since the plan the last round read
// (lib/plan-rounds.js keeps that plan and compares it): its scope is the
// changed tasks, each with its neighbors, and its changes are the diff. It is
// refused when there is no snapshot of that plan, and when the change is
// structural, since the brief would then say the rest of the plan had been
// reviewed when what it rests on had changed. A full brief says why it is not
// a delta, from the same facts.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { get, issueDir, resolveHome } from './config.js';
import * as git from './git.js';
import { planAreas } from './plan-areas.js';
import * as planReview from './plan-review.js';
import { PLAN_SECTIONS, SNAPSHOTS } from './plan-rounds.js';
import * as render from './render.js';
import { branchPoint, currentBranch, resolveBase } from './repo.js';

/** A full round reviews the scope whole; a delta round, what changed in it. */
export const MODES = ['full', 'delta'];

/**
 * The axes a critic can be given across the whole plan in place of an area,
 * by name. What an axis covers is the critic's checklist, in
 * agents/pd-plan-critic.md; this is the name the brief carries.
 */
export const AXES = {
  duplication: 'duplication and maintainer rules',
};

/**
 * The columns of the coverage map every critic report ends with, in order:
 * one row per task, a cell per check. The brief prints the table with every
 * cell `?`, and the critic turns into `✓` or `—` what it checked; what each
 * check is, agents/pd-plan-critic.md says under the same names.
 */
export const COVERAGE_CHECKS = ['Order', 'Runs on base', 'Fails if unmet', "Neighbor's pattern", 'Local rules', 'Environment modes', 'Duplication'];

/**
 * @typedef {object} TreeFacts
 * @property {string} cwd            where they were read
 * @property {string|null} branch
 * @property {string|null} head      short sha
 * @property {string} baseRef        the base branch as resolved, remote-tracking when it exists
 * @property {string|null} base      short sha of the merge-base of HEAD and baseRef, null when there is none
 * @property {number|null} ahead     commits on HEAD past that merge-base
 */

/**
 * The commit the code under review is read at.
 *
 * The merge-base rather than the base branch's tip: the tree was cut from the
 * base at some commit, and the plan's `file:line` were read there. A tree with
 * commits past it says how many, because then the critic reads code the plan
 * did not.
 *
 * @param {{cwd: string, config?: object}} input
 * @returns {Promise<TreeFacts>}
 */
export async function treeFacts(input) {
  const cwd = input.cwd;
  const named = String(get(input.config ?? {}, 'repo.base_branch') ?? 'main');
  const resolved = await resolveBase({ cwd, base: named, config: input.config });

  const branch = await currentBranch({ cwd });
  const head = await git.trimmedOrNull(['rev-parse', '--short', 'HEAD'], { cwd });
  const point = resolved.kind === 'unresolved' ? null : await branchPoint('HEAD', resolved.ref, { cwd });
  const base = point ? await git.trimmedOrNull(['rev-parse', '--short', point], { cwd }) : null;
  const ahead = point ? Number.parseInt((await git.trimmedOrNull(['rev-list', '--count', `${point}..HEAD`], { cwd })) ?? '', 10) : Number.NaN;

  return { cwd, branch, head, baseRef: resolved.ref, base, ahead: Number.isNaN(ahead) ? null : ahead };
}

/** A path, and whether it is there. Said, because a brief naming a file that does not exist sends the critic looking. */
async function located(path, what = 'file') {
  const found = await stat(path).catch(() => null);
  if (!found) return `\`${path}\` — absent`;
  if (what !== 'dir') return `\`${path}\``;
  const files = (await readdir(path).catch(() => [])).filter((name) => name.endsWith('.md'));
  return `\`${path}\` — ${files.length} task file(s)`;
}

/**
 * One decision, as two lines: the item, then what was decided.
 *
 * @param {number} round
 * @param {import('./plan-review.js').Decision} decision
 */
function decisionLine(round, decision) {
  return `- ${decision.id} (round ${round})${decision.title ? ` — ${decision.title}` : ''}\n  ${decision.text || decision.verdict}`;
}

/**
 * @typedef {object} BriefInput
 * @property {number} issue
 * @property {string} [home]
 * @property {'full'|'delta'} mode
 * @property {string[]|null} area        areas of the plan to narrow it to, as `plan areas` names them; null for the whole plan
 * @property {string|null} [axis]        a key of AXES: one question across the whole plan
 * @property {import('./artefacts.js').Plan} plan
 * @property {{withdrawn?: Record<string, unknown>}} record
 * @property {string[]} check            the lines `pdkit plan check` prints for this plan
 * @property {import('./plan-rounds.js').PlanDiff|null} [delta]   the plan against its last snapshot; a delta round needs it
 * @property {{path: string}|{error: string}} worktree   the issue's tree, or why there is none
 * @property {TreeFacts|null} tree       read in the worktree, else where the command ran; null outside git
 */

/**
 * The scope section of a brief narrowed to areas: its tasks, each with what it
 * owns and its edges, an edge that leaves the scope naming where it goes.
 *
 * Every Owns entry of a task, not only those in the scope's areas: the critic
 * reviews the task, and a task is one change.
 *
 * @param {string[]} names
 * @param {Set<string>} ids             the tasks of those areas
 * @param {ReturnType<typeof planAreas>} map
 * @returns {string[]}
 */
function areaScope(names, ids, map) {
  const inScope = map.tasks.filter((task) => ids.has(task.id));
  const outside = map.tasks.filter((task) => !ids.has(task.id)).map((task) => task.id);
  const byId = new Map(map.tasks.map((task) => [task.id, task]));
  const edge = (id) => (ids.has(id) ? id : `${id} (${byId.get(id)?.areas.join(', ')} — outside)`);
  const list = (edges) => (edges.length > 0 ? edges.map(edge).join(', ') : 'none');

  return [
    `The area${names.length > 1 ? 's' : ''} ${names.map((name) => `\`${name}\``).join(', ')}: ${inScope.map((task) => task.id).join(', ')} — ${inScope.length} of ${map.tasks.length} live task(s).`,
    outside.length > 0 ? `Outside it: ${outside.join(', ')}.` : 'Nothing is outside it.',
    '',
    ...inScope.flatMap((task) => [
      `- ${task.id} — ${task.title}`,
      `  Owns: ${task.owns.length > 0 ? task.owns.map((entry) => `\`${entry}\``).join(', ') : 'nothing — a verification'}`,
      `  After: ${list(task.after)}. Waited on by: ${list(task.waitedOnBy)}.`,
    ]),
  ];
}

/**
 * The coverage map a critic fills in: a row per task in its scope, every cell
 * `?` until the critic says otherwise.
 *
 * @param {string[]} ids
 * @returns {string[]}
 */
function coverageTable(ids) {
  return [
    `| Task | ${COVERAGE_CHECKS.join(' | ')} |`,
    `|---|${COVERAGE_CHECKS.map(() => '---').join('|')}|`,
    ...ids.map((id) => `| ${id} | ${COVERAGE_CHECKS.map(() => '?').join(' | ')} |`),
  ];
}

/** A list of IDs, or `none`. */
function idList(ids) {
  return ids.length > 0 ? ids.join(', ') : 'none';
}

/**
 * Why a round is full rather than a delta, from the facts a delta would need.
 *
 * @param {{round: number}|null} last
 * @param {import('./plan-rounds.js').PlanDiff|null} delta
 * @returns {string}
 */
function fullBecause(last, delta) {
  if (last === null) return 'this is the first round';
  if (delta?.base?.round !== last.round) return `the plan round ${last.round} read has no snapshot in \`${SNAPSHOTS}/\`, so what changed since is not known`;
  if (delta.structural) return `the change since round ${last.round} is structural: ${delta.because.join('; ')}`;
  return `the change since round ${last.round} is not structural, and a full round was asked for`;
}

/**
 * The scope of a delta round: each changed task, what changed in it and where,
 * and its neighbors — its After edges both ways and the frozen interfaces it
 * shares.
 *
 * @param {import('./plan-rounds.js').PlanDiff} since
 * @param {ReturnType<typeof planAreas>} map
 * @returns {string[]}
 */
function deltaScope(since, map) {
  const round = /** @type {{round: number}} */ (since.base).round;
  const titles = new Map(map.tasks.map((task) => [task.id, task.title]));
  const changed = since.tasks.changed;
  if (changed.length === 0) return [`No task changed since round ${round} read the plan.`];

  return [
    `The tasks changed since round ${round} read the plan: ${changed.map((task) => task.id).join(', ')} — ${changed.length} of ${map.tasks.length} live task(s). Under each, its neighbors: read them as far as the change depends on them.`,
    '',
    ...changed.flatMap((task) => [
      `- ${task.id} — ${titles.get(task.id) ?? 'not live: replaced or withdrawn'}`,
      `  Changed: ${task.parts.map((entry) => `${entry.part} (${entry.in.join(', ')})`).join('; ')}`,
      `  After: ${idList(task.neighbors.after)}. Waited on by: ${idList(task.neighbors.waitedOnBy)}.`,
      ...task.neighbors.interfaces.map(
        (entry) =>
          `  Frozen interface at plan.md:${entry.line}, ${entry.declares.length > 0 ? entry.declares.map((name) => `\`${name}\``).join(', ') : entry.head.length > 80 ? `${entry.head.slice(0, 79)}…` : entry.head}: shared with ${idList(entry.with)}.`,
      ),
    ]),
  ];
}

/**
 * The changes section of a delta round: what changed, part by part, then the
 * diff as far as it was kept.
 *
 * @param {import('./plan-rounds.js').PlanDiff} since
 * @returns {string[]}
 */
function deltaChanges(since) {
  const base = /** @type {{round: number, path: string}} */ (since.base);
  const plan = /** @type {NonNullable<typeof since.plan>} */ (since.plan);
  // Longer than any run of backticks in the diff: plan.md carries code fences,
  // and one in the diff would close a fence of three.
  const longest = Math.max(0, ...since.text.lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const hidden = since.text.total - since.text.lines.length;

  return [
    `Compared with \`${base.path}\`, the plan round ${base.round} read.`,
    '',
    `- Tasks added: ${idList(since.tasks.added)}. Removed: ${idList(since.tasks.removed)}. Changed: ${idList(since.tasks.changed.map((task) => task.id))}.`,
    `- ${Object.entries(PLAN_SECTIONS).map(([key, name]) => `${name}: ${plan[/** @type {keyof typeof plan} */ (key)] ? 'changed' : 'unchanged'}`).join('. ')}.`,
    `- Other parts of plan.md changed: ${since.other.length > 0 ? since.other.join(', ') : 'none'}.`,
    '',
    ...(since.text.total === 0 ? ['The files are the same.'] : [`${fence}diff`, ...since.text.lines, fence]),
    ...(hidden > 0 ? ['', `${hidden} more line(s) of diff are not shown: compare the snapshot with the plan for them.`] : []),
  ];
}

/**
 * The brief, rendered.
 *
 * Refuses rather than renders when the request names something that does not
 * exist: an area the plan has none of, an axis not in AXES, and a delta round
 * with no earlier round to be a delta of, or no snapshot of the plan that
 * round read. A brief that said "the e2e area" over a plan with no task there,
 * or "since round 0", would be a claim nothing measured. So would a delta over
 * a structural change: it says the rest of the plan was reviewed. An area and
 * an axis together are refused too: an axis is a question across the whole
 * plan, and an area cuts the plan; a delta round is one critic over what
 * changed, and takes neither.
 *
 * `unread` is every decision line from before the last round that opens with
 * none of the verdicts: it is in no list of the brief, and the caller says so
 * rather than dropping it.
 *
 * @param {BriefInput} input
 * @returns {Promise<{ok: true, text: string, round: number, unread: Array<{round: number, decision: import('./plan-review.js').Decision}>} | {ok: false, error: string}>}
 */
export async function brief(input) {
  if (!MODES.includes(input.mode)) return { ok: false, error: `--mode is one of ${MODES.join(', ')}, not "${input.mode}"` };
  const axis = input.axis ?? null;
  if (input.area !== null && axis !== null) return { ok: false, error: 'a brief is for an area or an axis, not both: an axis runs across the whole plan' };
  if (axis !== null && !Object.hasOwn(AXES, axis)) return { ok: false, error: `--axis is one of ${Object.keys(AXES).join(', ')}, not "${axis}"` };
  if (input.mode === 'delta' && (input.area !== null || axis !== null)) return { ok: false, error: 'a delta round is one critic over what changed, and takes no --area or --axis' };

  const withdrawn = input.record.withdrawn ?? {};
  const map = planAreas(input.plan, withdrawn);
  if (input.area !== null) {
    const known = map.areas.map((area) => area.name);
    const unknown = input.area.filter((name) => !known.includes(name));
    if (input.area.length === 0) return { ok: false, error: '--area needs the name of an area; `pdkit plan areas` lists them' };
    if (unknown.length > 0) return { ok: false, error: `the plan has no area ${unknown.join(', ')}; its areas are ${known.join(', ') || 'none'}` };
  }

  const home = input.home ?? resolveHome();
  const dir = issueDir(home, input.issue);
  const rounds = await planReview.rounds(input.issue, { home });
  const last = rounds.at(-1) ?? null;
  if (input.mode === 'delta' && last === null) return { ok: false, error: 'a delta round needs an earlier round, and there is no plan-review.md' };

  // The diff since the plan the last round read, when that is what it compares with.
  const delta = input.delta ?? null;
  const since = last !== null && delta?.base?.round === last.round ? delta : null;
  if (input.mode === 'delta' && since === null) {
    return { ok: false, error: `a delta round reviews what changed since round ${last?.round} read the plan, and there is no snapshot of that plan (${SNAPSHOTS}/r${last?.round}/): this round is a full one` };
  }
  if (input.mode === 'delta' && since?.structural) {
    return { ok: false, error: `the change since round ${last?.round} is structural — ${since.because.join('; ')}: a delta round does not cover it` };
  }

  const live = map.tasks.map((task) => task.id);
  const areas = input.area;
  const reviewed =
    input.mode === 'delta'
      ? (since?.tasks.changed ?? []).map((task) => task.id).filter((id) => live.includes(id))
      : areas === null
        ? live
        : live.filter((id) => map.areas.some((area) => areas.includes(area.name) && area.tasks.some((task) => task.id === id)));
  const scoped = input.mode === 'delta' && since !== null ? deltaScope(since, map) : areas === null ? null : areaScope(areas, new Set(reviewed), map);
  const named = live.length > 0 ? `: ${live.join(', ')}.` : '. It has no live task.';

  // The last round's decisions to check, and every round's rejections. A line
  // in no recognized form is listed with the last round's — it is what the
  // person decided, and checking it costs a line — and reported to the caller
  // from any earlier round.
  const toCheck = last ? last.decisions.filter((decision) => decision.verdict === 'accepted' || decision.verdict === 'other') : [];
  const rejected = rounds.flatMap((round) => round.decisions.filter((decision) => decision.verdict === 'rejected').map((decision) => decisionLine(round.round, decision)));
  const unread = rounds
    .filter((round) => round !== last)
    .flatMap((round) => round.decisions.filter((decision) => decision.verdict === 'other').map((decision) => ({ round: round.round, decision })));

  const revision = last && toCheck.length > 0 ? await planReview.pending(input.issue, { home }) : null;
  const accepted =
    last === null
      ? 'None: this is the first round.'
      : toCheck.length === 0
        ? `None: round ${last.round} accepted nothing.`
        : [
            ...toCheck.map((decision) => decisionLine(last.round, decision)),
            ...(revision?.pending && revision.round === last.round ? ['', `\`pdkit plan revised\` has not marked round ${last.round} applied.`] : []),
          ];

  const round = (last?.round ?? 0) + 1;
  const tree = input.tree;
  const worktree = 'path' in input.worktree ? `\`${input.worktree.path}\`${tree?.branch ? `, branch \`${tree.branch}\`` : ''}` : `none — ${input.worktree.error.split('\n')[0]}`;
  const base =
    tree === null
      ? 'unknown — not read inside a git repository'
      : tree.base === null
        ? `unknown — HEAD and \`${tree.baseRef}\` share no history in \`${tree.cwd}\``
        : `\`${tree.base}\`, the merge-base of HEAD and \`${tree.baseRef}\` in \`${tree.cwd}\`; ${tree.ahead ? `HEAD \`${tree.head}\` is ${tree.ahead} commit(s) past it` : 'HEAD is the base'}`;

  const changes = input.mode === 'delta' && since !== null ? deltaChanges(since) : 'None: a full round reviews the whole scope.';

  const text = await render.render(
    'criticBrief',
    {
      issue: input.issue,
      round,
      mode:
        input.mode === 'delta'
          ? `Delta: what changed since round ${last?.round} read the plan, and its neighbors. The change is not structural; the rest of the plan was reviewed in rounds up to ${last?.round}.`
          : `Full: the whole scope below — ${fullBecause(last, delta)}.`,
      scope: scoped ?? (axis !== null ? `The axis \`${axis}\` — ${AXES[/** @type {keyof typeof AXES} */ (axis)]} — across the whole plan${named}` : `The whole plan${named}`),
      planPath: await located(join(dir, 'plan.md')),
      tasksPath: await located(join(dir, 'tasks'), 'dir'),
      researchPath: await located(join(dir, 'research.md')),
      issuePath: await located(join(dir, 'issue.md')),
      worktree,
      base,
      check: input.check,
      accepted,
      rejected: rejected.length > 0 ? rejected : 'None.',
      changes,
      coverage: coverageTable(reviewed),
    },
    { stripComments: true, home },
  );

  return { ok: true, text, round, unread };
}

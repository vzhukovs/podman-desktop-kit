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
// Two places are left open: a scope narrower than the whole plan, and the
// diff a delta round reviews. Neither has a source yet, so today a scope
// cannot be named, and a delta round's change is the last round's decisions.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { get, issueDir, resolveHome } from './config.js';
import * as git from './git.js';
import * as planReview from './plan-review.js';
import * as render from './render.js';
import { branchPoint, currentBranch, resolveBase } from './repo.js';

/** A full round reviews the scope whole; a delta round, what changed in it. */
export const MODES = ['full', 'delta'];

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
 * @property {string|null} area          a scope narrower than the plan; none can be named yet
 * @property {import('./artefacts.js').Plan} plan
 * @property {{withdrawn?: Record<string, unknown>}} record
 * @property {string[]} check            the lines `pdkit plan check` prints for this plan
 * @property {{path: string}|{error: string}} worktree   the issue's tree, or why there is none
 * @property {TreeFacts|null} tree       read in the worktree, else where the command ran; null outside git
 */

/**
 * The brief, rendered.
 *
 * Refuses rather than renders when the request names something that does not
 * exist: an area, since nothing defines one yet, and a delta round with no
 * earlier round to be a delta of. A brief that said "the e2e area" over the
 * whole plan, or "since round 0", would be a claim nothing measured.
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
  if (input.area !== null) {
    return { ok: false, error: `no area is defined yet, so --area ${input.area} has nothing to narrow the plan to; leave it out to review the whole plan` };
  }

  const home = input.home ?? resolveHome();
  const dir = issueDir(home, input.issue);
  const rounds = await planReview.rounds(input.issue, { home });
  const last = rounds.at(-1) ?? null;
  if (input.mode === 'delta' && last === null) return { ok: false, error: 'a delta round needs an earlier round, and there is no plan-review.md' };

  const withdrawn = input.record.withdrawn ?? {};
  const live = input.plan.tasks.filter((task) => !task.replacedBy && !(task.id in withdrawn)).map((task) => task.id);

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

  const changes =
    input.mode === 'full'
      ? 'None: a full round reviews the whole scope.'
      : toCheck.length === 0
        ? `No diff is recorded, and round ${last?.round} accepted nothing: there is no change to review.`
        : `No diff is recorded. The change under review is round ${last?.round}'s accepted decisions, listed above.`;

  const text = await render.render(
    'criticBrief',
    {
      issue: input.issue,
      round,
      mode:
        input.mode === 'full'
          ? 'Full: the whole scope below.'
          : `Delta: what changed in the scope below since round ${last?.round}. The rest was reviewed in earlier rounds.`,
      scope: live.length > 0 ? `The whole plan: ${live.join(', ')}.` : 'The whole plan. It has no live task.',
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
    },
    { stripComments: true, home },
  );

  return { ok: true, text, round, unread };
}

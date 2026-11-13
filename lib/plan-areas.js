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

// The areas of a plan: its live tasks grouped by the part of the repository
// the paths in their `Owns` fall in, with the order edges between tasks.
//
// One critic does not cover a large plan. On a plan of a dozen tasks a single
// pd-plan-critic reached the ceiling of its context every round, and each new
// round, starting fresh, read a different part of the plan: findings that had
// been in the plan from the first round surfaced one round at a time, most of
// them in the tasks furthest from the core. Splitting the plan between critics
// needs the split first, and which task touches which part of the repository is
// a fact the plan already states. How the areas are grouped among critics, and
// what each critic looks at, is /pd:plan-review's judgment and not this module's.
//
// The edges go with the areas because a cut through a plan cuts its order: a
// critic that sees only its own tasks does not see that a task elsewhere waits
// on one of them, or that one of them waits on a task it will not read.

import { taskOrder } from './artefacts.js';

/** The area of a task that owns no files: a verification run over the tree, with nothing of its own to place. */
export const GATE = 'gate';

/** The area of a file at the top of the repository. */
export const ROOT = 'root';

/** Top-level directories whose children are separate packages, each an area of its own. */
const NESTED = ['packages', 'extensions'];

/**
 * The area a path from `Owns` falls in.
 *
 * `packages/<x>/…` and `extensions/<x>/…` are `packages/<x>` and
 * `extensions/<x>`: in podman-desktop each is its own package with its own
 * tests and rules. Anything else is its first directory (`tests`, `website`,
 * `storybook`), and a file at the top of the repository is `root`.
 *
 * A trailing slash names a directory, so `packages/main/` is `packages/main`
 * although it has no third segment. A wildcard is taken as written: an entry
 * whose package segment is `*` is in the area `packages/*`, which says what it
 * claims — any package — rather than guessing which one.
 *
 * @param {string} path
 * @returns {string}
 */
export function areaOf(path) {
  const text = String(path ?? '').trim().replace(/\\/g, '/');
  const directory = text.endsWith('/');
  const segments = text.replace(/^(?:\.\/|\/)+/, '').split('/').filter(Boolean);
  // A directory's last segment is a directory too; a file's is not.
  const folders = directory ? segments.length : segments.length - 1;

  if (folders === 0) return ROOT;
  if (NESTED.includes(segments[0]) && folders >= 2) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

/**
 * @typedef {object} AreaTask
 * @property {string} id
 * @property {string[]} owns     the task's Owns entries that fall in this area
 */

/**
 * @typedef {object} Area
 * @property {string} name
 * @property {AreaTask[]} tasks  in the order the plan writes them
 */

/**
 * @typedef {object} TaskEdges
 * @property {string} id
 * @property {string} title
 * @property {string[]} areas       every area it is in, first to last by its Owns
 * @property {string[]} owns        every entry of its Owns
 * @property {string[]} after       the live tasks it waits on
 * @property {string[]} waitedOnBy  the live tasks that wait on it, in the plan's order
 */

/**
 * The live tasks of a plan, by area.
 *
 * A task whose Owns falls in several areas is in each of them, since each
 * area's critic reads it. A task that owns nothing is in `gate`. A task an
 * amendment replaced or the record withdrew is no work anybody will do; it is
 * in no area and is listed in `notLive`, so leaving it out is said.
 *
 * The edges are those exec follows (artefacts.taskOrder): an `After` naming a
 * withdrawn task stands for what replaced it. An `After` naming a task the plan
 * does not have is dropped here, and `plan check` reports it.
 *
 * Areas come in the order of the first task in each, tasks in each area in the
 * order the plan writes them.
 *
 * @param {import('./artefacts.js').Plan} plan
 * @param {Record<string, {replacedBy?: string[]}>} [withdrawn]   the record's withdrawals
 * @returns {{areas: Area[], tasks: TaskEdges[], notLive: string[]}}
 */
export function planAreas(plan, withdrawn = {}) {
  const live = plan.tasks.filter((task) => !task.replacedBy && !(task.id in withdrawn));
  const { dependsOn } = taskOrder(plan.tasks, withdrawn);

  /** @type {Map<string, string[]>} */
  const waitedOnBy = new Map(live.map((task) => [task.id, []]));
  for (const task of live) {
    for (const need of dependsOn.get(task.id) ?? []) waitedOnBy.get(need)?.push(task.id);
  }

  /** @type {Map<string, AreaTask[]>} */
  const areas = new Map();
  /** @type {TaskEdges[]} */
  const tasks = [];

  for (const task of live) {
    /** @type {Map<string, string[]>} */
    const byArea = new Map(task.owns.length === 0 ? [[GATE, []]] : []);
    for (const path of task.owns) {
      const name = areaOf(path);
      byArea.set(name, [...(byArea.get(name) ?? []), path]);
    }

    for (const [name, owns] of byArea) areas.set(name, [...(areas.get(name) ?? []), { id: task.id, owns }]);
    tasks.push({
      id: task.id,
      title: task.title,
      areas: [...byArea.keys()],
      owns: task.owns,
      after: dependsOn.get(task.id) ?? [],
      waitedOnBy: waitedOnBy.get(task.id) ?? [],
    });
  }

  return {
    areas: [...areas].map(([name, members]) => ({ name, tasks: members })),
    tasks,
    notLive: plan.tasks.filter((task) => !live.includes(task)).map((task) => task.id),
  };
}

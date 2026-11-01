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

// `pdkit worktree`: working trees for parallel work.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { resolveHome } from '../config.js';
import * as ids from '../ids.js';
import * as worktree from '../worktree.js';
import { EXIT, issueFlag, printJson, repoContext, treeHasLanded } from './support.js';

export const flags = ['issue', 'name', 'slug', 'branch', 'ref', 'force'];

export const ACTIONS = {
  list,
  create: withName(create),
  remove: withName(remove),
};

/**
 * Working trees for parallel work.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0];

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit worktree: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: repo.root });
  const issue = issueFlag(flags);
  const name = typeof flags.name === 'string' ? flags.name : Number.isInteger(issue) ? `DESKTOP-${issue}` : null;

  const context = { action, repo, home, issue, name };
  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : withName(unknown);
  return handler(context, flags);
}

async function list({ repo }, flags) {
  const trees = await worktree.list(repo.root);
  if (flags.json) printJson(trees);
  else {
    for (const tree of trees) {
      process.stdout.write(`  ${tree.main ? '*' : ' '} ${tree.branch ?? '(detached)'}  ${tree.path}\n`);
    }
  }
  return EXIT.OK;
}

/**
 * Every action but list names a tree, and the name is required before the
 * action runs — an unknown action included.
 *
 * @param {(context: object, flags: Record<string, string|boolean>) => Promise<number>} handler
 */
function withName(handler) {
  return async (context, flags) => {
    const { action, name } = context;
    if (!name) {
      process.stderr.write(`pdkit worktree ${action ?? ''}: --issue <n> or --name <name> is required\n`);
      return EXIT.ERROR;
    }

    return handler(context, flags);
  };
}

async function create({ repo, home, issue, name }, flags) {
  // The branch is derived from the slug rather than typed, so the name the
  // tree is on is the name preflight and the gate will later check against.
  // Typing it by hand is how `DESKTOP-18778/wrap` and `DESKTOP-18778-wrap`
  // both come to exist for one issue.
  let branch = typeof flags.branch === 'string' ? flags.branch : undefined;
  if (!branch && typeof flags.slug === 'string' && Number.isInteger(issue)) {
    try {
      branch = ids.branchName({ issue, slug: flags.slug, config: repo.config });
    } catch (error) {
      process.stderr.write(`pdkit worktree create: ${error.message}\n`);
      return EXIT.ERROR;
    }
  }

  const result = await worktree.create({
    repoRoot: repo.root,
    name,
    ref: typeof flags.ref === 'string' ? flags.ref : undefined,
    branch,
    issue: Number.isInteger(issue) ? issue : undefined,
    config: repo.config,
    home,
  });

  if (!result.ok) {
    process.stderr.write(`pdkit worktree create: ${result.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ ...result, branch: branch ?? null });
  else {
    process.stdout.write(`${result.path}${result.created ? '' : ' (already there)'}\n`);
    if (branch) process.stdout.write(`  on ${branch}\n`);
    if (result.copied?.length) process.stdout.write(`  copied: ${result.copied.join(', ')}\n`);

    // Said here rather than left to preflight. A tree with no branch is a
    // legitimate thing to want — you may be looking around before naming the
    // work — so this does not refuse. But the cost of finding out later is
    // paid at the worst moment: preflight is the step before the gate, by
    // which point there are commits on a detached HEAD and the fix is a
    // branch plus an amend. Found on DESKTOP-18778, exactly that way.
    if (!branch && Number.isInteger(issue) && result.created) {
      process.stdout.write(
        '  detached, so there is no branch to push yet.\n' +
          `  \`pdkit worktree create --issue ${issue} --slug <slug>\` names one, or\n` +
          `  \`git checkout -b $(pdkit ids branch --issue ${issue} --slug <slug>)\` inside the tree.\n`,
      );
    }
  }
  return EXIT.OK;
}

async function remove({ repo, home, issue, name }, flags) {
  const result = await worktree.remove({
    repoRoot: repo.root,
    name,
    force: Boolean(flags.force),
    landed: await treeHasLanded(repo.root, name, issue, repo.config, home),
    issue: Number.isInteger(issue) ? issue : undefined,
    config: repo.config,
    home,
  });

  if (!result.ok) {
    process.stderr.write(`pdkit worktree remove: ${result.error}\n`);
    return EXIT.ERROR;
  }

  process.stdout.write(
    result.removed ? `${name} removed${result.leftover ? ' — git left files behind; deleted' : ''}\n` : `${name} was not there\n`,
  );
  return EXIT.OK;
}

async function unknown({ action }) {
  process.stderr.write(`pdkit worktree: unknown action "${action ?? ''}" (create, list, remove)\n`);
  return EXIT.ERROR;
}

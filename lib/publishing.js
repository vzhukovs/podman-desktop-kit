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

// Where a pull request is opened, and the three writes that follow the opening:
// the base it opens against, checked; the pull request itself, through the
// gate; its record in prs.json; the move to pr-open. Apart from the CLI because
// this is the plugin's most consequential write to somebody else's repository,
// and `pr create` and `publish` are two ways to ask for it, not two owners of it.

import { get } from './config.js';
import * as gh from './gh.js';
import * as pr from './pr.js';
import * as slice from './slice.js';
import * as state from './state.js';

/**
 * The base a pull request for this branch opens against, checked.
 *
 * The graph is read BEFORE the write, not after it. A stacked slice's base is
 * the predecessor's branch — preflight measured the diff against exactly that —
 * and the pull request has to open against the same thing or it carries work
 * its own body says it does not.
 *
 * Shared by `pr create` and `publish`, and in `publish` it runs before the push:
 * a base upstream does not have is then refused while nothing is public yet.
 *
 * @param {{issue: number, branch: string, base?: unknown, config: object, home: string}} input
 * @returns {Promise<{ok: true, base: string, index: number|null} | {ok: false, error: string}>}
 */
export async function pullRequestBase(input) {
  const { config } = input;
  const graph = await slice.read(input.issue, { home: input.home });
  const entry = graph?.slices.find((item) => item.branch === input.branch) ?? null;
  const index = entry?.index ?? null;

  const defaultBase = String(get(config, 'repo.base_branch') ?? 'main');
  const stackedOn = entry?.baseSlice ? (graph?.slices.find((item) => item.index === entry.baseSlice)?.branch ?? null) : null;
  const base = typeof input.base === 'string' ? input.base : (stackedOn ?? defaultBase);

  // A base that is not the default has to be a branch of the repository the
  // pull request opens against, and a slice branch lives in the fork. This is
  // where the first multi-slice live run went wrong: the stack was verified,
  // preflighted and shown to the user against slice #1's branch, and then
  // opened against `main` with four files instead of two.
  //
  // Checked before gh.createPullRequest, so a refusal leaves the token
  // unspent and no pull request behind.
  if (base !== defaultBase) {
    const exists = await gh.upstreamBranchExists(base, { config });
    if (exists === false) {
      return {
        ok: false,
        error:
          `${base} is not a branch of ${get(config, 'repo.upstream')}, so no pull request can open against it.\n` +
          (stackedOn === base
            ? `  Slice #${index} is stacked on it, and a stack is only expressible when the branches and the pull\n` +
              '  requests live in the same repository. Working from a fork, they do not.\n' +
              '  Either merge that slice first and run this again, or open against ' +
              `${defaultBase} with --base ${defaultBase} —\n` +
              '  and then the body has to say that the diff carries the other slice until it lands.\n'
            : '  A base is a branch of the repository the pull request opens against, not of your fork.\n'),
      };
    }
    if (exists === null) {
      return { ok: false, error: `could not check whether ${base} exists in ${get(config, 'repo.upstream')}\n` };
    }
  }

  return { ok: true, base, index };
}

/**
 * Open the pull request, record it, and move the issue to pr-open.
 *
 * Throws when GitHub refuses; `unrecorded` is set when the pull request exists
 * and the record could not follow it.
 *
 * @param {{issue: number, branch: string, base: string, index: number|null, title: string, body: string, config: object, home: string}} input
 * @returns {Promise<{result: {number: number|null, url: string, base: string}, unrecorded: string|null}>}
 */
export async function openPullRequest(input) {
  // gh.createPullRequest verifies and spends the token itself. It is not
  // trusted from here: the Bash hook cannot see a child process, so this is
  // the only place that check can live for the plugin's own path.
  const result = await gh.createPullRequest({
    head: input.branch,
    base: input.base,
    title: input.title,
    body: input.body,
    config: input.config,
    home: input.home,
  });

  // Registered here rather than left to the flow. A pull request whose number
  // exists only in the transition reason is a pull request no later command
  // can find, and a step that can be forgotten is a step that will be.
  if (result.number) {
    await pr.register({
      issue: input.issue,
      number: result.number,
      slice: input.index,
      branch: input.branch,
      // What was opened, not what was asked for.
      base: result.base,
      url: result.url,
      home: input.home,
    });
  }

  const moved = await state.transition(input.issue, 'pr-open', { reason: `#${result.number} ${result.url}`, home: input.home });
  return { result, unrecorded: moved.ok ? null : moved.error };
}

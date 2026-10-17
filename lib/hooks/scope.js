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

// Whether a gated command acts on podman-desktop at all.
//
// The consent gate exists to keep writes off somebody else's repository. Bash
// hooks are global, so until this module existed the gate also refused
// `git push` in every other repository on the machine, this plugin's own
// included, and the only way past was a /pd:pr flow built for podman-desktop.
//
// The answer is asymmetric on purpose. "Outside" has to be PROVEN, from the
// working tree's remotes and from the command line; anything that cannot be
// proven is inside, and the gate applies exactly as before. A wrong "inside"
// costs one refusal in a repository the gate did not need to guard. A wrong
// "outside" is an ungated push to upstream, which is the one failure this
// plugin exists to prevent.
//
// What it does not change: `deny` rules (force push, --no-verify, add -A,
// rebase -i, issue writes) apply everywhere. Those are hygiene, not consent.

import { get, load } from '../config.js';
import { resolveRepoRoot } from '../repo.js';
import { parse } from './command-parse.js';

/** The repository's name, whatever the configuration says. */
const DEFAULT_NAME = 'podman-desktop';

/**
 * Programs that move the shell, so the working tree in the payload is no
 * longer where the gated command runs: `cd ~/podman-desktop && git push`.
 */
const MOVES = ['cd', 'pushd', 'popd'];

/** git options that point a command at another repository. */
const ELSEWHERE_OPTIONS = ['-C', '--git-dir', '--work-tree'];

/**
 * Environment that points git or gh at another repository. Checked in the
 * command text and in the hook's own environment: the hook cannot see the
 * shell's, and the two usually come from the same profile.
 */
const ELSEWHERE_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GH_REPO'];

/**
 * @typedef {object} Scope
 * @property {boolean} outside      proven not to act on podman-desktop
 * @property {string} reason        what was found, either way
 * @property {string|null} [root]
 */

/**
 * The slugs and repository names that identify podman-desktop.
 *
 * The literal name is always included. A clone of the fork before `pdkit init`
 * has an empty `repo.fork`, and its only remote is `<you>/podman-desktop` —
 * matching the name is what keeps that clone gated.
 *
 * @param {import('../config.js').Config} config
 * @returns {{slugs: string[], names: string[]}}
 */
export function identities(config) {
  const slugs = ['repo.upstream', 'repo.fork']
    .map((key) => get(config, key))
    .filter((value) => typeof value === 'string' && value.includes('/'))
    .map((value) => String(value).toLowerCase());

  const names = [...new Set([DEFAULT_NAME, ...slugs.map((slug) => slug.split('/').pop() ?? '')])].filter(Boolean);
  return { slugs, names };
}

/**
 * Whether text names podman-desktop: a slug, or the name as a whole word.
 *
 * "Whole word" stops at `-`, `_` and letters, so `podman-desktop-kit` is not a
 * match, and does not stop at `.`, so `podman-desktop.git` is.
 *
 * @param {string} text
 * @param {{slugs: string[], names: string[]}} ids
 * @returns {boolean}
 */
export function names(text, ids) {
  const lower = text.toLowerCase();
  if (ids.slugs.some((slug) => lower.includes(slug))) return true;
  return ids.names.some((name) =>
    new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(lower),
  );
}

/**
 * What in the command line could send it somewhere the working tree does not
 * describe, or null.
 *
 * @param {string} commandLine
 * @param {{slugs: string[], names: string[]}} ids
 * @returns {string|null}
 */
export function redirection(commandLine, ids) {
  if (names(commandLine, ids)) return 'the command names podman-desktop';

  const env = ELSEWHERE_ENV.find((name) => commandLine.includes(name));
  if (env) return `the command sets ${env}`;

  for (const command of parse(commandLine)) {
    if (MOVES.includes(command.program)) return `the command changes directory (${command.program})`;
    const option = (command.globals ?? []).find((arg) => ELSEWHERE_OPTIONS.includes(arg.split('=')[0]));
    if (option) return `the command runs ${command.program} ${option.split('=')[0]}`;
  }

  return null;
}

/**
 * Decide whether a gated command is proven to act outside podman-desktop.
 *
 * Never throws: a failure anywhere is an `inside` with the failure as its
 * reason, so the gate goes on deciding as it did before this module existed.
 *
 * @param {{commandLine: string, cwd: string, env?: Record<string, string|undefined>, config?: import('../config.js').Config}} input
 * @returns {Promise<Scope>}
 */
export async function scope(input) {
  try {
    const env = input.env ?? process.env;
    const set = ELSEWHERE_ENV.find((name) => env[name]);
    if (set) return { outside: false, reason: `${set} is set in the environment` };

    const config = input.config ?? (await load({ repoRoot: input.cwd }));
    const ids = identities(config);

    const redirected = redirection(input.commandLine, ids);
    if (redirected) return { outside: false, reason: redirected };

    const repo = await resolveRepoRoot({ cwd: input.cwd, config });
    if (!repo.root) return { outside: false, reason: `${input.cwd} is not inside a git repository` };

    const remotes = Object.entries(repo.remotes);
    const ours = remotes.find(([, slug]) => names(slug, ids) || ids.slugs.includes(slug.toLowerCase()));
    if (ours) return { outside: false, reason: `remote "${ours[0]}" is ${ours[1]}`, root: repo.root };

    return {
      outside: true,
      root: repo.root,
      reason:
        remotes.length === 0
          ? `${repo.root} has no remotes`
          : `${repo.root} has no podman-desktop remote (${remotes.map(([name, slug]) => `${name}: ${slug}`).join(', ')})`,
    };
  } catch (error) {
    return { outside: false, reason: `could not tell where the command acts (${error.message})` };
  }
}

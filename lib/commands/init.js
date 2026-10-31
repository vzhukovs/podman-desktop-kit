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

// `pdkit init`: create $PDKIT_HOME and generate the package map.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { constants as FS } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

import { DEFAULTS_PATH, get, load, paths, resolveHome } from '../config.js';
import { buildPackageMap } from '../repo.js';
import { SETTINGS_FILE, sessionModel, writeModel } from '../session-model.js';
import { EXIT, counted, printJson, repoContext } from './support.js';

export const flags = ['force'];

/** The `fork:` line in the shipped config, which is the only one init rewrites. */
const FORK_LINE = /^(\s*)fork:.*$/m;

/**
 * Fill `repo.fork` from the remote the clone already has.
 *
 * Reading it beats asking for it: `pdkit init` is run from inside the clone, so
 * the answer is one `git remote get-url` away, and a flag would make the user
 * retype a value they are standing in. The slug is written into
 * $PDKIT_HOME/config.yaml rather than into the repository, because that file is
 * the one every worktree shares — a `.pdkit.yaml` in the checkout is invisible
 * from the issue worktrees where the work actually happens.
 *
 * The line is rewritten in place rather than the file being regenerated: the
 * comments in defaults/config.yaml carry the reasoning for half the settings,
 * and a round-trip through the writer would drop every one of them.
 *
 * @param {{repo: {remotes: Record<string, string>, config: object}, config: string}} input
 * @returns {Promise<{ok: true, fork: string} | {ok: false, error: string}>}
 */
export async function adoptFork(input) {
  const remoteName = String(get(input.repo.config, 'repo.fork_remote') ?? 'origin');
  const upstream = get(input.repo.config, 'repo.upstream');
  const slug = input.repo.remotes[remoteName];

  if (!slug) {
    return { ok: false, error: `there is no "${remoteName}" remote to read the fork from — add one, or set repo.fork by hand` };
  }

  // Cloning upstream directly and calling it a fork is the mistake this guard
  // exists for. Accepting it would point every push at the project itself, and
  // the gate would be protecting a branch in somebody else's repository.
  if (slug === upstream) {
    return {
      ok: false,
      error:
        `"${remoteName}" is ${slug}, which is the upstream repository rather than a fork. ` +
        'Fork it on GitHub, point this remote at your fork, and add upstream as a second remote',
    };
  }

  const text = await readFile(input.config, 'utf8');
  if (!FORK_LINE.test(text)) {
    return { ok: false, error: `${input.config} has no "fork:" line to fill — set repo.fork by hand` };
  }

  await writeFile(input.config, text.replace(FORK_LINE, `$1fork: ${slug}`));
  return { ok: true, fork: slug };
}

/**
 * Create $PDKIT_HOME and generate the package map.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const repo = await repoContext(flags);

  if (!repo.root) {
    process.stderr.write(`pdkit init: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }
  // A key with no value is what this command exists to fill, so it is not a
  // reason to refuse to run. A key with the WRONG value still is: initializing
  // against the wrong clone writes a package map for a workspace nothing else
  // will act on, and every later command inherits it.
  const disagrees = repo.problems.length > (repo.unset?.length ?? 0);

  if (!repo.matches && disagrees && !flags.force) {
    process.stderr.write(
      `pdkit init: ${repo.root} does not look like the configured fork\n` +
        repo.problems.map((problem) => `  - ${problem}\n`).join('') +
        '  use --force to initialize anyway\n',
    );
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: repo.root });
  const layout = paths(home);

  for (const dir of [layout.home, layout.issues, layout.gates, layout.journal, layout.reviews]) {
    await mkdir(dir, { recursive: true });
  }

  // Copied rather than serialized: the comments in defaults/config.yaml carry
  // the reasoning for several settings, and a round-trip through the writer
  // would drop every one of them.
  let configCreated = false;
  try {
    await copyFile(DEFAULTS_PATH, layout.config, flags.force ? 0 : FS.COPYFILE_EXCL);
    configCreated = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  // The clone knows whose fork it is. Asking for it on the command line would
  // be asking the user to read out a value they are standing inside.
  let fork = null;
  if ((repo.unset ?? []).includes('repo.fork')) {
    const adopted = await adoptFork({ repo, config: layout.config });
    if (!adopted.ok) {
      process.stderr.write(`pdkit init: ${adopted.error}\n`);
      return EXIT.ERROR;
    }
    fork = adopted.fork;
  }

  // Re-read: the package map is filed by layer, and the layers come from config.
  const config = fork ? await load({ repoRoot: repo.root, home }) : repo.config;
  const map = await buildPackageMap(repo.root, { home, config });

  // The key init just filled is no longer a problem to report.
  const warnings = repo.problems.filter((problem) => !fork || !problem.startsWith('repo.fork'));

  // The model a fresh `claude` in the fork starts on, counted from the skills'
  // frontmatter rather than chosen here. A skill's `model:` lasts one turn and
  // the session's model survives `/clear`, so this is the default that runs a
  // phase whenever nobody types `/model`. settings.local.json, never
  // settings.json: git tracks that one, and a line in it rides in every PR.
  const derived = await sessionModel();
  let settings = null;
  if (derived.model) {
    settings = await writeModel({ repoRoot: repo.root, model: derived.model, force: Boolean(flags.force) });
    if (!settings.ok) {
      process.stderr.write(`pdkit init: ${settings.error} — fix or remove it; nothing was written to it\n`);
      return EXIT.ERROR;
    }
  } else {
    warnings.push(`no model written to ${SETTINGS_FILE}: the orchestrating skills split evenly or declare none`);
  }

  if (flags.json) {
    printJson({
      home,
      repo: repo.root,
      configCreated,
      fork,
      packages: Object.keys(map.packages).length,
      settings: settings && { path: settings.path, model: settings.model, action: settings.action, previous: settings.previous },
      warnings,
    });
    return EXIT.OK;
  }

  const settingsLine = !settings
    ? ''
    : settings.action === 'kept'
      ? `  model       : ${JSON.stringify(settings.previous)} already in ${settings.path} (kept${
          settings.previous === settings.model ? '' : `; the skills say ${settings.model}, --force to replace`
        })\n`
      : `  model       : ${settings.model} in ${settings.path} (${
          settings.action === 'replaced' ? `replaced ${JSON.stringify(settings.previous)}` : settings.action
        }; skills say ${counted(derived.counts)})\n`;

  process.stdout.write(
    `pdkit initialized\n` +
      `  repository  : ${repo.root}\n` +
      `  state home  : ${home}\n` +
      `  config      : ${layout.config}${configCreated ? ' (created)' : ' (kept)'}\n` +
      (fork ? `  fork        : ${fork} (read from the "${get(repo.config, 'repo.fork_remote')}" remote)\n` : '') +
      settingsLine +
      // Not written: nothing confirms Claude Code reads effortLevel from a
      // project's settings, and an unknown key is swallowed without a word.
      `  effort      : not set by pdkit — use /effort or --effort per session\n` +
      `  package map : ${Object.keys(map.packages).length} packages\n`,
  );
  for (const problem of warnings) process.stdout.write(`  warning     : ${problem}\n`);

  return EXIT.OK;
}

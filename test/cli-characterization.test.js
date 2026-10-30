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

// What every command prints, byte for byte, on inputs that cannot do anything.
//
// lib/cli.js is about to be taken apart into lib/commands/*. The unit tests of
// the modules will not notice a handler that moved and lost a line on the way,
// and the CLI tests that exist pick their cases. The likeliest regression of a
// move is the quietest one: an error worded differently, or a different check
// running first, so somebody who typed the same thing reads a different answer.
// This file is the net for that. For each command in COMMANDS it records
// stdout, stderr and the exit code of:
//
//   pdkit <command>
//   pdkit <command> --definitely-unknown-flag
//   pdkit <command> no-such-action
//
// plus `pdkit`, `pdkit --help` and `pdkit no-such-command`. The values are
// test/fixtures/cli-characterization.json, generated from the code as it was
// before the refactoring started.
//
// THE SNAPSHOT IS NOT UPDATED IN A REFACTORING STEP. A diff in it is the
// regression this file exists to catch; regenerating it makes the net say
// whatever the code now does. It is regenerated only by a change that means to
// alter what a user sees, and that change says so in its commit:
//
//   PDKIT_UPDATE_SNAPSHOT=1 node --test test/cli-characterization.test.js
//
// End to end through bin/pdkit, as the other CLI tests are: the exit code is
// the one the process ends with, and each run gets its own environment.
//
// Every run has a fresh $PDKIT_HOME and CLAUDE_CONFIG_DIR in a temp directory,
// and a working directory outside any repository. `init` and `worktree` refuse
// that before reading anything else, so they are also run inside a fixture
// repository from test/helpers/repo-fixture.js. Temp paths are replaced with
// placeholders, and separators after them made `/`, so one snapshot holds on
// macOS, Linux and Windows.
//
// Left out, because they reach past the machine or depend on it (the unknown
// flag case of each is kept: it is refused before anything runs):
//   - `doctor`, `doctor no-such-action`: run `gh auth status`, `gh --version`
//     and `pnpm --version`, and print what this machine has installed;
//   - `stats`, `stats no-such-action`: `gh pr list` against the upstream repo.
// `hook` is left out whole: it reads a payload from stdin and has its own
// tests (hook-stdin, prompt-submit, task-completed, dispatch).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from '../lib/cli.js';
import { slugOf } from '../lib/cost.js';
import { initRepo, writeFiles, commitAll, cleanup } from './helpers/repo-fixture.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'pdkit');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'cli-characterization.json');
const UPDATE = process.env.PDKIT_UPDATE_SNAPSHOT === '1';

/** Inputs that would leave the machine, or describe it. See the header. */
const EXCLUDED = new Set(['doctor', 'doctor no-such-action', 'stats', 'stats no-such-action']);

/** Commands that stop at "not inside a git repository" without one. */
const NEEDS_REPO = ['init', 'worktree'];

/**
 * @typedef {{key: string, argv: string[], inRepo: boolean}} Case
 * @typedef {{exitCode: number|null, stdout: string, stderr: string}} Observed
 */

/** @returns {Case[]} */
function cases() {
  /** @type {Case[]} */
  const all = [];
  const add = (argv, inRepo = false) => {
    const key = ['pdkit', ...argv].join(' ') + (inRepo ? ' [in a repository]' : '');
    if (!EXCLUDED.has(argv.join(' '))) all.push({ key, argv, inRepo });
  };

  add([]);
  add(['--help']);
  add(['no-such-command']);
  for (const command of COMMANDS) {
    if (command === 'hook') continue;
    add([command]);
    add([command, '--definitely-unknown-flag']);
    add([command, 'no-such-action']);
  }
  for (const command of NEEDS_REPO) {
    add([command], true);
    add([command, 'no-such-action'], true);
  }
  return all;
}

/**
 * Every spelling a directory can come back in: as created, resolved (macOS
 * puts the temp directory behind /var -> /private/var), resolved natively
 * (Windows 8.3 short names), and with forward slashes, which is how git prints
 * a Windows path.
 *
 * @param {string} path
 * @returns {string[]}
 */
function spellings(path) {
  const forms = new Set([path]);
  try {
    forms.add(realpathSync(path));
    forms.add(realpathSync.native(path));
  } catch {
    // Only reached if the directory is gone; the given spelling is enough.
  }
  for (const form of [...forms]) forms.add(form.replaceAll('\\', '/'));
  return [...forms];
}

/** `<version> (<commit>[, modified])`, once package.json has been read. */
let VERSION_LINE = /$^/;

/**
 * Replace temp paths with placeholders, longest spelling first so a parent
 * never eats the start of its child.
 *
 * @param {string} text
 * @param {Record<string, string>} dirs placeholder name -> directory
 * @returns {string}
 */
function normalize(text, dirs) {
  /** @type {[string, string][]} */
  const pairs = [];
  for (const [name, dir] of Object.entries(dirs)) {
    for (const form of spellings(dir)) {
      pairs.push([form, `<${name}>`]);
      // Claude Code's transcript directory is named after the working one.
      pairs.push([slugOf(form), `<${name}_SLUG>`]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);

  let out = text;
  for (const [from, to] of pairs) out = out.replaceAll(from, to);

  // What follows a placeholder was joined with the platform separator.
  // Only ours: USAGE has `<A>` and `<D>` of its own.
  const names = Object.keys(dirs).join('|');
  out = out.replace(new RegExp(`(<(?:${names})>)([^\\s'"\`]*)`, 'g'), (_, head, tail) => head + tail.replaceAll('\\', '/'));

  // `pdkit version` names the release and the commit it was run from, and the
  // commit is a different one in every step of the refactoring.
  return out.replace(VERSION_LINE, '<VERSION> (<COMMIT>)');
}

/**
 * An environment that is this suite's and nobody else's: the developer's own
 * $PDKIT_HOME, session and git variables would otherwise reach the command.
 *
 * @param {Record<string, string>} own
 * @returns {NodeJS.ProcessEnv}
 */
function environment(own) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(PDKIT_|CLAUDE_|GIT_)/.test(name)) delete env[name];
  }
  delete env.PODMAN_DESKTOP_BINARY;
  delete env.TEST_PODMAN_MACHINE;
  return { ...env, ...own };
}

/**
 * @param {string[]} argv
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} options
 * @returns {Promise<Observed>}
 */
function pdkit(argv, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [BIN, ...argv],
      { ...options, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A non-zero exit is an outcome to record; anything else is the harness.
        if (error && typeof error.code !== 'number') return reject(error);
        resolve({ exitCode: error ? error.code : 0, stdout, stderr });
      },
    );
    // Nothing on stdin, and the end of it, so no command waits for a payload.
    child.stdin?.end();
  });
}

describe('every command, characterized', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let repo;
  /** @type {Record<string, Observed>} */
  let expected = {};
  /** @type {Record<string, Observed>} */
  const observed = {};
  const all = cases();

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-characterize-')));
    await mkdir(join(root, 'cwd'));

    repo = await initRepo('pdkit-characterize-repo-');
    await writeFiles(repo, { 'README.md': 'fixture\n' });
    await commitAll(repo, 'initial');

    const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    VERSION_LINE = new RegExp(`^${version.replaceAll('.', '\\.')} \\([0-9a-f]+(, modified)?\\)$`, 'm');

    if (!UPDATE) expected = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  });

  after(async () => {
    if (UPDATE) {
      await mkdir(dirname(SNAPSHOT), { recursive: true });
      await writeFile(SNAPSHOT, `${JSON.stringify(observed, null, 2)}\n`);
    }
    await cleanup(root, repo);
  });

  all.forEach((entry, index) => {
    test(entry.key, async () => {
      const home = join(root, String(index), 'home');
      const config = join(root, String(index), 'claude');
      await mkdir(home, { recursive: true });
      await mkdir(config, { recursive: true });
      const cwd = entry.inRepo ? repo : join(root, 'cwd');

      const raw = await pdkit(entry.argv, { cwd, env: environment({ PDKIT_HOME: home, CLAUDE_CONFIG_DIR: config }) });
      const dirs = { PDKIT_HOME: home, CLAUDE_CONFIG_DIR: config, CWD: join(root, 'cwd'), REPO: repo };
      const result = {
        exitCode: raw.exitCode,
        stdout: normalize(raw.stdout, dirs),
        stderr: normalize(raw.stderr, dirs),
      };
      observed[entry.key] = result;

      if (UPDATE) return;
      assert.ok(entry.key in expected, `no snapshot for "${entry.key}" — a new command or input; see the header of this file`);
      assert.deepEqual(result, expected[entry.key]);
    });
  });

  // A command removed from COMMANDS takes its cases with it, and every test
  // left would still pass.
  test('the snapshot names exactly the cases above', { skip: UPDATE }, () => {
    assert.deepEqual(Object.keys(expected).sort(), all.map((entry) => entry.key).sort());
  });
});

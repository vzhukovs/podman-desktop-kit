// SPDX-License-Identifier: Apache-2.0

// Tests for lib/hooks/owns.js.
//
// This hook is what turns the ownership map from a request in a prompt into a
// property of the system, so both directions are asserted in pairs. A hook that
// blocks planned work gets switched off within a day, and one that lets a
// worker write anywhere is decoration.
//
// The repository here is a real git repository rather than a mock: the hook
// asks git which working tree a file belongs to, and a mock would assert what
// we believe git answers.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { start, stop } from '../lib/active.js';
import { handle } from '../lib/hooks/owns.js';
import { setOwns } from '../lib/state.js';

const execFileAsync = promisify(execFile);

const ISSUE = 18248;
const OWNS = ['packages/main/src/plugin/container-registry.ts', 'packages/main/src/**/*.spec.ts'];

let home;
let repo;
let outside;
const savedHome = process.env.PDKIT_HOME;

/**
 * @param {string} path
 * @param {string} [cwd]
 */
function write(path, cwd) {
  return handle({ tool_name: 'Write', tool_input: { file_path: path }, ...(cwd ? { cwd } : {}) }, { event: 'pre-write', pluginRoot: '' });
}

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-owns-home-')));
  // The real path, because git reports the real path: on macOS the temporary
  // directory is reached through a symlink, and a pointer keyed on the other
  // spelling would never be found.
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-owns-repo-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-owns-out-')));

  process.env.PDKIT_HOME = home;

  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await mkdir(join(repo, 'packages/main/src/plugin'), { recursive: true });
  await mkdir(join(repo, 'packages/renderer/src'), { recursive: true });
  await writeFile(join(repo, 'packages/main/src/plugin/container-registry.ts'), '');

  await setOwns(ISSUE, 'T1', OWNS, { home });
});

after(async () => {
  if (savedHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = savedHome;

  for (const dir of [home, repo, outside]) await rm(dir, { recursive: true, force: true });
});

describe('with a task running', () => {
  before(async () => {
    await start({ issue: ISSUE, taskId: 'T1', worktree: repo, home });
  });

  test('a file the task owns is allowed', async () => {
    const decision = await write(join(repo, 'packages/main/src/plugin/container-registry.ts'));
    assert.equal(decision.block, false);
  });

  test('a file the task owns through a pattern is allowed', async () => {
    const decision = await write(join(repo, 'packages/main/src/plugin/container-registry.spec.ts'));
    assert.equal(decision.block, false);
  });

  // The pair that matters: the neighbouring file, in the same repository, one
  // directory across.
  test('a file in the same repository that the task does not own is refused', async () => {
    const decision = await write(join(repo, 'packages/renderer/src/App.svelte'));

    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'owns');
    assert.match(decision.reason, /packages\/renderer\/src\/App\.svelte is not owned by T1/);
    // The refusal shows the whole owned set: the next thing the worker needs to
    // know is which file it was supposed to be writing.
    assert.match(decision.reason, /container-registry\.ts/);
    assert.match(decision.reason, /planning error/);
  });

  test('a near miss on the pattern is refused', async () => {
    const decision = await write(join(repo, 'packages/main/src/plugin/container-registry.spec.tsx'));
    assert.equal(decision.block, true);
  });

  test('a relative path is resolved against the session directory', async () => {
    const owned = await write('packages/main/src/plugin/container-registry.ts', repo);
    assert.equal(owned.block, false);

    const other = await write('packages/renderer/src/App.svelte', repo);
    assert.equal(other.block, true);
  });

  // An agent standing in one repository can be asked to write into another;
  // the decision follows the file, not the shell.
  test('a file outside any repository is allowed whatever the session directory', async () => {
    const decision = await write(join(outside, 'notes.md'), repo);
    assert.equal(decision.block, false);
  });

  test('no file path is not a decision', async () => {
    const decision = await handle({ tool_name: 'Write', tool_input: {} }, { event: 'pre-write', pluginRoot: '' });
    assert.equal(decision.block, false);
  });
});

describe('without a task running', () => {
  before(async () => {
    await stop({ worktree: repo, home });
  });

  // The deliberate hole, asserted so it stays deliberate: the constraint
  // belongs to executing a task, not to having the plugin installed. What
  // catches a worker started outside `pdkit task start` is `pdkit audit`,
  // which counts files changed outside every Owns set.
  test('any file in the repository is allowed', async () => {
    const decision = await write(join(repo, 'packages/renderer/src/App.svelte'));
    assert.equal(decision.block, false);
  });
});

describe('a task with no recorded ownership', () => {
  before(async () => {
    await start({ issue: 4242, taskId: 'T9', worktree: repo, home });
  });

  after(async () => {
    await stop({ worktree: repo, home });
  });

  // Blocking everything here would make an unsynced plan look like a broken
  // tool. Saying nothing would hide that the map is empty. So: allow, and say
  // which command fills it.
  test('allows the write and says the map is empty', async () => {
    const decision = await write(join(repo, 'packages/renderer/src/App.svelte'));

    assert.equal(decision.block, false);
    assert.match(decision.message, /no recorded Owns set/);
    assert.match(decision.message, /pdkit task sync --issue 4242/);
  });
});

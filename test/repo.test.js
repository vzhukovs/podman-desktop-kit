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

// Contract for lib/repo.js.
//
// The package map is generated rather than written by hand, so the tests that
// matter are the ones about what generation may not do: skip a package,
// approximate a glob, or quietly file something under a layer that does not
// own it. Layer order decides merge order for slices, and a wrong order is
// invisible until a slice fails to apply.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  UNKNOWN_LAYER,
  buildPackageMap,
  changedFiles,
  changedLines,
  changedPaths,
  commits,
  currentBranch,
  layerFor,
  packageFor,
  parseTrailers,
  pickScript,
  remoteSlug,
  resolveRepoRoot,
  resolveBase,
  scripts,
} from '../lib/repo.js';
import { cleanup, commitAll, git as fixtureGit, initRepo, writeFiles } from './helpers/repo-fixture.js';

const execFileAsync = promisify(execFile);

const LAYERS = ['extension-api', 'main', 'preload', 'renderer', 'ui', 'extensions', 'tests', 'website'];
const CONFIG = { slicing: { layer_order: LAYERS } };

let repo;

/**
 * @param {string} dir
 * @param {string} name
 */
async function addPackage(dir, name) {
  await mkdir(join(repo, dir), { recursive: true });
  await writeFile(join(repo, dir, 'package.json'), JSON.stringify({ name }));
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pdkit-repo-'));

  // The shape of the real workspace, cut down: nested extension packages, a
  // matched directory that is not a package, and a package outside every glob.
  await writeFile(
    join(repo, 'pnpm-workspace.yaml'),
    ["packages:", "  - 'packages/*'", "  - 'extensions/*'", "  - 'extensions/*/packages/*'", "  - 'tests/*'", '  - website', ''].join('\n'),
  );

  await addPackage('packages/main', '@pd/main');
  await addPackage('packages/extension-api', '@pd/api');
  await addPackage('packages/preload-webview', 'preload-webview');
  await addPackage('extensions/podman', 'podman-container');
  await addPackage('extensions/podman/packages/extension', 'podman');
  await addPackage('tests/playwright', '@pd/tests-playwright');
  await addPackage('website', 'docs');
  await addPackage('packages/webview-api', '@pd/webview-api');
  await mkdir(join(repo, 'extensions/no-manifest'), { recursive: true });
  await addPackage('not-in-workspace', 'stranger');
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('buildPackageMap', () => {
  test('expands globs, including the nested one', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    assert.equal(map.packages['@pd/main'].path, 'packages/main');
    assert.equal(map.packages.podman.path, 'extensions/podman/packages/extension');
    assert.equal(map.packages['@pd/tests-playwright'].path, 'tests/playwright');
    assert.equal(map.packages.docs.path, 'website');
  });

  test('a directory without a package.json is not a package', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    assert.equal(Object.values(map.packages).some((entry) => entry.path === 'extensions/no-manifest'), false);
  });

  test('a package outside every pattern stays out', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    assert.equal(map.packages.stranger, undefined);
  });

  test('assigns layers from the configured order', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    assert.equal(map.packages['@pd/main'].layer, 'main');
    assert.equal(map.packages['@pd/api'].layer, 'extension-api');
    assert.equal(map.packages['preload-webview'].layer, 'preload');
    assert.equal(map.packages.podman.layer, 'extensions');
    assert.equal(map.packages.docs.layer, 'website');
  });

  // Silence here would be the dangerous outcome: a package folded into the
  // nearest layer reorders merges, and nothing reports it.
  test('an unclaimed package is marked, not guessed at', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    assert.equal(map.packages['@pd/webview-api'].layer, UNKNOWN_LAYER);
    assert.equal(map.layers.at(-1), UNKNOWN_LAYER);
  });

  test('writes the map when asked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pdkit-home-'));
    await buildPackageMap(repo, { config: CONFIG, home });
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(await readFile(join(home, 'package-map.json'), 'utf8'));
    assert.equal(written.workspaceRoot, repo);
    assert.ok(written.generatedAt);
    await rm(home, { recursive: true, force: true });
  });

  test('refuses ** rather than approximating it', async () => {
    const other = await mkdtemp(join(tmpdir(), 'pdkit-repo-'));
    await writeFile(join(other, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/**'\n");
    await assert.rejects(() => buildPackageMap(other, { config: CONFIG, write: false }), /\*\*/);
    await rm(other, { recursive: true, force: true });
  });
});

describe('layerFor', () => {
  test('a top-level layer directory claims everything under it', () => {
    assert.equal(layerFor('extensions/podman/packages/extension', LAYERS), 'extensions');
    assert.equal(layerFor('tests/playwright', LAYERS), 'tests');
  });

  test('a package directory matches its layer by name or prefix', () => {
    assert.equal(layerFor('packages/ui', LAYERS), 'ui');
    assert.equal(layerFor('packages/preload-docker-extension', LAYERS), 'preload');
    assert.equal(layerFor('website-argos', LAYERS), 'website');
  });

  // extension-api is checked before main and ui, or a shorter layer that
  // happens to be a prefix would take the public surface with it.
  test('the longest layer name wins', () => {
    assert.equal(layerFor('packages/extension-api', LAYERS), 'extension-api');
  });

  test('no match is UNKNOWN_LAYER', () => {
    assert.equal(layerFor('storybook', LAYERS), UNKNOWN_LAYER);
    assert.equal(layerFor('packages/api', LAYERS), UNKNOWN_LAYER);
  });
});

describe('packageFor', () => {
  test('the longest path wins', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    const owner = await packageFor('extensions/podman/packages/extension/src/index.ts', { map });
    assert.equal(owner.name, 'podman');
  });

  test('a file in no package is null, not a guess', async () => {
    const map = await buildPackageMap(repo, { config: CONFIG, write: false });
    assert.equal(await packageFor('docs/README.md', { map }), null);
  });
});

describe('remoteSlug', () => {
  // ssh and https forms of the same remote have to compare equal, or doctor
  // reports a mismatch on a repository that is in fact the right one.
  test('normalizes every form git writes', () => {
    assert.equal(remoteSlug('git@github.com:vzhukovs/podman-desktop.git'), 'vzhukovs/podman-desktop');
    assert.equal(remoteSlug('https://github.com/podman-desktop/podman-desktop.git'), 'podman-desktop/podman-desktop');
    assert.equal(remoteSlug('https://github.com/podman-desktop/podman-desktop'), 'podman-desktop/podman-desktop');
    assert.equal(remoteSlug('ssh://git@github.com/a/b.git'), 'a/b');
  });

  test('an unrecognized url is not forced into a slug', () => {
    assert.equal(remoteSlug('/srv/mirrors/podman-desktop'), null);
  });
});

// git primitives (stage 1)
//
// Run against a real repository built in a temporary directory rather than
// against mocks: what is being asserted is what git prints, and a mock would
// assert what we believed git prints.
describe('git primitives', () => {
  let work;

  const run_ = (args, cwd = work) => execFileAsync('git', args, { cwd, encoding: 'utf8' });

  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'pdkit-repo-git-'));

    await run_(['init', '-q', '-b', 'main']);
    await run_(['config', 'user.email', 'test@example.com']);
    await run_(['config', 'user.name', 'Test']);
    await run_(['config', 'commit.gpgsign', 'false']);

    await writeFile(join(work, 'kept.txt'), 'base\n');
    await writeFile(join(work, 'removed.txt'), 'gone soon\n');
    await writeFile(join(work, 'package.json'), JSON.stringify({ scripts: { 'lint:check': 'x', typecheck: 'y' } }));
    await run_(['add', 'kept.txt', 'removed.txt', 'package.json']);
    await run_(['commit', '-q', '-m', 'chore: base']);

    await run_(['checkout', '-q', '-b', 'DESKTOP-3001/work']);

    await writeFile(join(work, 'added.ts'), 'export const x = 1;\n');
    await writeFile(join(work, 'kept.txt'), 'changed\n');
    await run_(['rm', '-q', 'removed.txt']);
    await run_(['add', 'added.ts', 'kept.txt']);
    await run_(['commit', '-q', '-m', 'feat(main): add x\n\nSigned-off-by: Test <test@example.com>']);

    await writeFile(join(work, 'added.ts'), 'export const x = 2;\n');
    await run_(['add', 'added.ts']);
    await run_(['commit', '-q', '-m', 'fix: bump x\n\nSigned-off-by: Test <test@example.com>\nSigned-off-by: Test <test@example.com>']);

    // Something landing on main after the branch forked. Two-dot ranges would
    // report it as part of the branch; three-dot ranges must not.
    await run_(['checkout', '-q', 'main']);
    await writeFile(join(work, 'landed-on-main.txt'), 'meanwhile\n');
    await run_(['add', 'landed-on-main.txt']);
    await run_(['commit', '-q', '-m', 'chore: unrelated']);
    await run_(['checkout', '-q', 'DESKTOP-3001/work']);
  });

  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test('currentBranch reports the checked-out branch', async () => {
    assert.equal(await currentBranch({ cwd: work }), 'DESKTOP-3001/work');
  });

  test('currentBranch is null outside a repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pdkit-repo-nogit-'));
    try {
      assert.equal(await currentBranch({ cwd: outside }), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('changedPaths reports the status of each path', async () => {
    const changed = await changedPaths('main', 'HEAD', { cwd: work });
    const byPath = Object.fromEntries(changed.map((entry) => [entry.path, entry.status]));

    assert.equal(byPath['added.ts'], 'A');
    assert.equal(byPath['kept.txt'], 'M');
    assert.equal(byPath['removed.txt'], 'D');
  });

  // The reason for three dots. Two would pull in what main gained after the
  // fork, and preflight would then check files the branch never touched.
  test('changes on the base since the fork are not the branch changes', async () => {
    const files = await changedFiles('main', 'HEAD', { cwd: work });
    assert.ok(!files.includes('landed-on-main.txt'), 'a commit on main leaked into the branch diff');
  });

  test('commits lists what the branch adds, newest first', async () => {
    const list = await commits('main', 'HEAD', { cwd: work });

    assert.equal(list.length, 2);
    assert.equal(list[0].subject, 'fix: bump x');
    assert.equal(list[1].subject, 'feat(main): add x');
    assert.match(list[0].sha, /^[0-9a-f]{40}$/);
  });

  // The husky hook counts Signed-off-by lines and rejects a duplicate, so
  // preflight has to be able to see two of them.
  test('trailers keep repeats', async () => {
    const list = await commits('main', 'HEAD', { cwd: work });

    assert.deepEqual(list[1].trailers['Signed-off-by'], ['Test <test@example.com>']);
    assert.equal(list[0].trailers['Signed-off-by'].length, 2);
  });

  test('an empty range is an empty list, not an error', async () => {
    assert.deepEqual(await commits('HEAD', 'HEAD', { cwd: work }), []);
    assert.deepEqual(await changedFiles('HEAD', 'HEAD', { cwd: work }), []);
  });

  test('scripts come from the repository, and pickScript takes the first that exists', async () => {
    const available = await scripts(work);

    assert.ok('lint:check' in available);
    assert.equal(pickScript(available, ['lint', 'lint:check']), 'lint:check');
    assert.equal(pickScript(available, ['typecheck:main', 'typecheck']), 'typecheck');
    assert.equal(pickScript(available, ['test:unit']), null);
  });

  test('a directory with no package.json has no scripts', async () => {
    assert.deepEqual(await scripts('/definitely/not/here'), {});
  });
});

describe('parseTrailers', () => {
  test('reads a trailer block and ignores prose', () => {
    const trailers = parseTrailers('Some explanation.\n\nSigned-off-by: A <a@b>\nCloses: #12');

    assert.deepEqual(trailers['Signed-off-by'], ['A <a@b>']);
    assert.deepEqual(trailers.Closes, ['#12']);
    assert.equal(trailers['Some explanation.'], undefined);
  });

  test('an empty body has no trailers', () => {
    assert.deepEqual(parseTrailers(''), {});
    assert.deepEqual(parseTrailers(undefined), {});
  });
});

describe('which ref the base branch means', () => {
  // The first live run: a fork whose local `main` was 491 commits behind
  // upstream turned a two-file diff into an 805-file one, and preflight
  // reported four blocking failures about other people's work. Nothing looked
  // wrong — the base was a real commit and the diff applied.
  let origin;
  let clone;

  before(async () => {
    origin = await initRepo('pdkit-base-origin-');
    await writeFiles(origin, { 'a.txt': 'one\n' });
    await commitAll(origin, 'first');

    clone = await initRepo('pdkit-base-clone-');
    await fixtureGit(['remote', 'add', 'upstream', origin], clone);
    await fixtureGit(['fetch', '-q', 'upstream'], clone);
    await fixtureGit(['reset', '--hard', '-q', 'upstream/main'], clone);

    // Upstream moves on; the clone does not pull.
    await writeFiles(origin, { 'b.txt': 'two\n' });
    await commitAll(origin, 'second');
    await fixtureGit(['fetch', '-q', 'upstream'], clone);
  });

  after(async () => {
    await cleanup(origin, clone);
  });

  test('the remote-tracking ref wins, and says how far the local copy has fallen behind', async () => {
    const resolved = await resolveBase({ cwd: clone, base: 'main', config: { repo: { upstream_remote: 'upstream' } } });

    assert.equal(resolved.ref, 'upstream/main');
    assert.equal(resolved.kind, 'remote');
    assert.equal(resolved.localBehind, 1);
    assert.ok(resolved.sha && resolved.at, 'the ref is dated, because it is only as fresh as the last fetch');
  });

  test('the diff against it is the one a reviewer would see', async () => {
    const resolved = await resolveBase({ cwd: clone, base: 'main', config: { repo: { upstream_remote: 'upstream' } } });

    // Against the stale local branch the upstream commit reads as ours.
    assert.deepEqual(await changedFiles('main', 'upstream/main', { cwd: clone }), ['b.txt']);
    assert.deepEqual(await changedFiles(resolved.ref, 'upstream/main', { cwd: clone }), []);
  });

  test('with no such remote it falls back to the local branch and says so', async () => {
    const resolved = await resolveBase({ cwd: origin, base: 'main', config: { repo: { upstream_remote: 'upstream' } } });

    assert.equal(resolved.ref, 'main');
    assert.equal(resolved.kind, 'local');
    assert.equal(resolved.localBehind, null);
  });

  test('a base that resolves nowhere is reported, not guessed at', async () => {
    const resolved = await resolveBase({ cwd: origin, base: 'no-such-branch', config: {} });

    assert.equal(resolved.kind, 'unresolved');
    assert.equal(resolved.sha, null);
  });
});

describe('changedLines', () => {
  test('counts per file, and a binary file is null rather than zero', async () => {
    const root = await initRepo('pdkit-numstat-');
    try {
      await writeFiles(root, { 'a.txt': 'one\n' });
      await commitAll(root, 'first');
      await fixtureGit(['checkout', '-q', '-b', 'work'], root);
      await writeFiles(root, { 'a.txt': 'one\ntwo\n', 'bin.dat': '\u0000\u0001binary\u0000' });
      await commitAll(root, 'second');

      const counted = await changedLines('main', 'work', { cwd: root });
      const text = counted.find((entry) => entry.path === 'a.txt');
      const binary = counted.find((entry) => entry.path === 'bin.dat');

      assert.equal(text.added, 1);
      assert.equal(text.removed, 0);
      assert.equal(binary.added, null, 'no line count is not a line count of zero');
    } finally {
      await cleanup(root);
    }
  });
});

// The shipped config cannot know whose fork somebody cloned, so `repo.fork`
// ships empty and `pdkit init` fills it from the remote. That makes "not set
// yet" a third state, distinct from "set to something that disagrees" — and
// reporting the first as the second is what sent a new user looking for a
// setting they had got wrong rather than one they had not made.
describe('a fork slug that has not been set yet', () => {
  let repo;

  const CONFIG = (fork) => ({
    repo: { upstream: 'podman-desktop/podman-desktop', fork, upstream_remote: 'upstream', fork_remote: 'origin' },
  });

  before(async () => {
    repo = await initRepo('pdkit-resolve-');
    await fixtureGit(['remote', 'add', 'origin', 'git@github.com:jdoe/podman-desktop.git'], repo);
    await fixtureGit(['remote', 'add', 'upstream', 'https://github.com/podman-desktop/podman-desktop.git'], repo);
  });

  after(async () => {
    await cleanup(repo);
  });

  test('empty is reported as unset, not as a mismatch against nothing', async () => {
    const result = await resolveRepoRoot({ cwd: repo, config: CONFIG('') });

    assert.deepEqual(result.unset, ['repo.fork']);
    assert.equal(result.matches, false);
    assert.match(result.problems[0], /repo\.fork is not set yet/);
    assert.equal(/expected\s*$/.test(result.problems[0]), false, 'never "expected " with nothing after it');
  });

  test('a slug that disagrees is a mismatch, and is not called unset', async () => {
    const result = await resolveRepoRoot({ cwd: repo, config: CONFIG('someone-else/podman-desktop') });

    assert.deepEqual(result.unset, []);
    assert.match(result.problems[0], /is jdoe\/podman-desktop, expected someone-else/);
  });

  test('the matching slug leaves nothing to report', async () => {
    const result = await resolveRepoRoot({ cwd: repo, config: CONFIG('jdoe/podman-desktop') });

    assert.equal(result.matches, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.unset, []);
    // What init reads to fill the key.
    assert.equal(result.remotes.origin, 'jdoe/podman-desktop');
  });
});

// SPDX-License-Identifier: Apache-2.0

// Contract for lib/repo.js.
//
// The package map is generated rather than written by hand, so the tests that
// matter are the ones about what generation may not do: skip a package,
// approximate a glob, or quietly file something under a layer that does not
// own it. Layer order decides merge order for slices, and a wrong order is
// invisible until a slice fails to apply.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UNKNOWN_LAYER, buildPackageMap, layerFor, packageFor, remoteSlug } from '../lib/repo.js';

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

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

// Contract for lib/config.js.
//
// The layering itself is easy; the two things worth pinning are that an
// override wins per key without erasing its siblings, and that arrays are
// replaced rather than concatenated. `never_rewrite` and `layer_order` decide
// whether a command may run and in what order slices merge — a list assembled
// from two halves is a list nobody wrote.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HOME,
  DEFAULTS_PATH,
  definedIn,
  expandTilde,
  get,
  issueDir,
  layers,
  load,
  paths,
  resolveHome,
} from '../lib/config.js';

let root;
let home;
let repo;
const savedHomeEnv = process.env.PDKIT_HOME;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdkit-config-'));
  home = join(root, 'home');
  repo = join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
});

after(async () => {
  if (savedHomeEnv === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = savedHomeEnv;
  await rm(root, { recursive: true, force: true });
});

describe('expandTilde', () => {
  test('expands a leading ~', () => {
    assert.equal(expandTilde('~'), homedir());
    assert.equal(expandTilde('~/.pdkit'), join(homedir(), '.pdkit'));
  });

  test('leaves everything else alone', () => {
    assert.equal(expandTilde('/tmp/x'), '/tmp/x');
    assert.equal(expandTilde('a/~/b'), 'a/~/b');
  });
});

describe('resolveHome', () => {
  test('the environment wins', () => {
    process.env.PDKIT_HOME = home;
    assert.equal(resolveHome(), home);
  });

  test('a repository override moves the home', async () => {
    delete process.env.PDKIT_HOME;
    await writeFile(join(repo, '.pdkit.yaml'), `state:\n  root: ${join(root, 'from-repo')}\n`);
    assert.equal(resolveHome({ repoRoot: repo }), join(root, 'from-repo'));
  });

  // The home config cannot be asked where the home is; that is the one layer
  // resolveHome must ignore, or the answer depends on itself.
  test('falls back to the shipped default', async () => {
    delete process.env.PDKIT_HOME;
    const empty = join(root, 'no-overrides');
    await mkdir(empty, { recursive: true });
    assert.equal(resolveHome({ repoRoot: empty }), expandTilde(DEFAULT_HOME));
  });
});

describe('load', () => {
  test('later layers override earlier ones per key', async () => {
    process.env.PDKIT_HOME = home;
    await writeFile(join(home, 'config.yaml'), 'slicing:\n  max_files_per_slice: 4\n');

    const config = await load();
    assert.equal(get(config, 'slicing.max_files_per_slice'), 4);
    // Untouched siblings survive: an override is not a replacement of the map.
    assert.equal(get(config, 'slicing.strategy'), 'prefer-independent');
    assert.equal(get(config, 'repo.base_branch'), 'main');
  });

  test('the repository layer wins over the home layer', async () => {
    process.env.PDKIT_HOME = home;
    await writeFile(join(repo, '.pdkit.yaml'), 'slicing:\n  max_files_per_slice: 7\n');

    const config = await load({ repoRoot: repo });
    assert.equal(get(config, 'slicing.max_files_per_slice'), 7);
  });

  test('arrays are replaced wholesale, never merged', async () => {
    process.env.PDKIT_HOME = home;
    await writeFile(join(home, 'config.yaml'), 'slicing:\n  layer_order: [main, ui]\n');

    const config = await load();
    assert.deepEqual(get(config, 'slicing.layer_order'), ['main', 'ui']);
  });

  test('a layer that does not parse names the file', async () => {
    process.env.PDKIT_HOME = home;
    await writeFile(join(home, 'config.yaml'), 'broken: |\n  block scalar\n');

    await assert.rejects(() => load(), (error) => error.message.includes(join(home, 'config.yaml')));
    await writeFile(join(home, 'config.yaml'), '');
  });

  test('a missing optional layer is not an error', async () => {
    process.env.PDKIT_HOME = join(root, 'nowhere');
    const config = await load();
    assert.equal(get(config, 'version'), 1);
  });
});

describe('layers', () => {
  test('lists the three files in merge order', () => {
    const list = layers({ home, repoRoot: repo });
    assert.deepEqual(
      list.map((layer) => layer.name),
      ['defaults', 'home', 'repo'],
    );
    assert.equal(list[0].path, DEFAULTS_PATH);
    assert.equal(list[0].required, true);
  });
});

describe('get', () => {
  test('reads a dotted path', () => {
    assert.equal(get({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
  });

  test('a missing path is undefined, not a crash', () => {
    assert.equal(get({ a: 1 }, 'a.b.c'), undefined);
    assert.equal(get({}, 'nothing'), undefined);
  });
});

describe('paths', () => {
  test('names every directory pdkit owns', () => {
    const p = paths(home);
    assert.equal(p.config, join(home, 'config.yaml'));
    assert.equal(p.packageMap, join(home, 'package-map.json'));
    assert.equal(p.journal, join(home, 'journal'));
    assert.equal(issueDir(home, 12345), join(home, 'issues', '12345'));
  });
});

// `pdkit init` copies the whole defaults file into $PDKIT_HOME, so a default
// the plugin later changes goes on being shadowed by that copy — and the report
// that blames the value should be able to say which file decided it.
describe('definedIn', () => {
  test('names the last layer that defines a key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pdkit-defined-home-'));
    const repo = await mkdtemp(join(tmpdir(), 'pdkit-defined-repo-'));

    try {
      await writeFile(join(home, 'config.yaml'), 'slicing:\n  layer_order: [main]\n');

      const fromHome = definedIn('slicing.layer_order', { home, repoRoot: repo });
      assert.equal(fromHome.name, 'home');
      assert.equal(fromHome.path, join(home, 'config.yaml'));

      await writeFile(join(repo, '.pdkit.yaml'), 'slicing:\n  layer_order: [ui]\n');
      assert.equal(definedIn('slicing.layer_order', { home, repoRoot: repo }).name, 'repo');

      // A key only the shipped defaults define still resolves.
      assert.equal(definedIn('gates.push_ttl', { home, repoRoot: repo }).name, 'defaults');
      assert.equal(definedIn('nothing.like.this', { home, repoRoot: repo }), null);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});

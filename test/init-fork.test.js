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

// Tests for the one thing `pdkit init` works out for itself.
//
// The shipped config cannot name somebody else's fork, so it ships the key
// empty and init reads it from the remote. Asking for it on the command line
// would be asking the user to read out a value they are standing inside — but
// reading it means the two ways of getting it wrong have to be caught here,
// because both produce a plausible-looking slug: no remote to read, and a
// clone of upstream that was never forked at all.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptFork } from '../lib/cli.js';
import { SETTINGS_FILE, sessionModel, writeModel } from '../lib/session-model.js';

const CONFIG_TEXT = [
  'repo:',
  '  upstream: podman-desktop/podman-desktop',
  '  # a comment that has to survive',
  '  fork: ""',
  '  upstream_remote: upstream',
  '  fork_remote: origin',
].join('\n');

const REPO_CONFIG = { repo: { upstream: 'podman-desktop/podman-desktop', fork_remote: 'origin' } };

let dir;
let config;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdkit-init-fork-'));
  config = join(dir, 'config.yaml');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('reading the fork from the clone', () => {
  test('the slug is written in, and the comments survive', async () => {
    await writeFile(config, CONFIG_TEXT);

    const result = await adoptFork({ repo: { remotes: { origin: 'jdoe/podman-desktop' }, config: REPO_CONFIG }, config });

    assert.deepEqual(result, { ok: true, fork: 'jdoe/podman-desktop' });

    const written = await readFile(config, 'utf8');
    assert.match(written, /^ {2}fork: jdoe\/podman-desktop$/m);
    assert.match(written, /a comment that has to survive/, 'rewriting the line must not regenerate the file');
    assert.match(written, /^ {2}fork_remote: origin$/m, 'fork_remote is a different key and is left alone');
  });

  // Cloning upstream and calling it a fork points every push at the project
  // itself, and the gate would then be guarding a branch in somebody else's
  // repository. The one case where guessing is worse than refusing.
  test('a clone of upstream is refused rather than adopted', async () => {
    await writeFile(config, CONFIG_TEXT);

    const result = await adoptFork({
      repo: { remotes: { origin: 'podman-desktop/podman-desktop' }, config: REPO_CONFIG },
      config,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /upstream repository rather than a fork/);
    assert.match(await readFile(config, 'utf8'), /^ {2}fork: ""$/m, 'nothing is written on refusal');
  });

  test('no remote to read is said plainly', async () => {
    await writeFile(config, CONFIG_TEXT);

    const result = await adoptFork({ repo: { remotes: { upstream: 'podman-desktop/podman-desktop' }, config: REPO_CONFIG }, config });

    assert.equal(result.ok, false);
    assert.match(result.error, /no "origin" remote/);
  });

  test('a config with no fork line is reported, not silently skipped', async () => {
    await writeFile(config, 'repo:\n  upstream: podman-desktop/podman-desktop\n');

    const result = await adoptFork({ repo: { remotes: { origin: 'jdoe/podman-desktop' }, config: REPO_CONFIG }, config });

    assert.equal(result.ok, false);
    assert.match(result.error, /no "fork:" line/);
  });
});

// The other thing init writes into the fork: the model a fresh `claude` starts
// on. settings.json is podman-desktop's own tracked file, so the one thing that
// must never happen is a write to it; the second is losing the permission rules
// settings.local.json already holds.
describe('the session model in the fork', () => {
  let fork;

  const LOCAL = {
    permissions: { allow: ['Bash(pnpm test:*)', 'Bash(git status)'], deny: [] },
    enabledMcpjsonServers: ['playwright'],
  };

  const local = () => join(fork, '.claude', 'settings.local.json');
  const tracked = () => join(fork, '.claude', 'settings.json');

  before(async () => {
    fork = await mkdtemp(join(tmpdir(), 'pdkit-init-settings-'));
  });

  after(async () => {
    await rm(fork, { recursive: true, force: true });
  });

  async function seed(text) {
    await rm(join(fork, '.claude'), { recursive: true, force: true });
    await mkdir(join(fork, '.claude'), { recursive: true });
    await writeFile(tracked(), '{\n  "upstream": true\n}\n');
    if (text !== undefined) await writeFile(local(), text);
  }

  test('goes into settings.local.json, and settings.json is not touched', async () => {
    await seed(`${JSON.stringify(LOCAL, null, 2)}\n`);

    const result = await writeModel({ repoRoot: fork, model: 'sonnet' });

    assert.equal(SETTINGS_FILE, join('.claude', 'settings.local.json'));
    assert.equal(result.path, local());
    assert.equal(await readFile(tracked(), 'utf8'), '{\n  "upstream": true\n}\n', 'the tracked file is upstream\'s');
  });

  test('the keys already there survive, in their order and indentation', async () => {
    await seed(`${JSON.stringify(LOCAL, null, 4)}\n`);

    const result = await writeModel({ repoRoot: fork, model: 'sonnet' });

    assert.equal(result.action, 'added');
    const text = await readFile(local(), 'utf8');
    assert.deepEqual(JSON.parse(text), { ...LOCAL, model: 'sonnet' });
    assert.deepEqual(Object.keys(JSON.parse(text)), ['permissions', 'enabledMcpjsonServers', 'model']);
    assert.match(text, /^ {4}"permissions"/m, 'four-space indentation is kept, not reflowed to two');
    assert.ok(text.endsWith('}\n'));
  });

  test('a model already there is kept without --force, and named', async () => {
    await seed(JSON.stringify({ ...LOCAL, model: 'opus' }, null, 2));
    const before = await readFile(local(), 'utf8');

    const kept = await writeModel({ repoRoot: fork, model: 'sonnet' });

    assert.equal(kept.action, 'kept');
    assert.equal(kept.previous, 'opus');
    assert.equal(await readFile(local(), 'utf8'), before, 'not even reformatted');

    const replaced = await writeModel({ repoRoot: fork, model: 'sonnet', force: true });

    assert.equal(replaced.action, 'replaced');
    assert.equal(replaced.previous, 'opus');
    assert.equal(JSON.parse(await readFile(local(), 'utf8')).model, 'sonnet');
  });

  test('a missing file is created with the one key', async () => {
    await rm(join(fork, '.claude'), { recursive: true, force: true });

    const result = await writeModel({ repoRoot: fork, model: 'sonnet' });

    assert.equal(result.action, 'created');
    assert.equal(await readFile(local(), 'utf8'), '{\n  "model": "sonnet"\n}\n');
    await assert.rejects(stat(tracked()), { code: 'ENOENT' }, 'creating .claude/ is not a reason to create settings.json');
  });

  // The file holds the person's permission rules. Reading it as empty and
  // writing `{"model": ...}` over it is the failure that loses all of them.
  test('invalid JSON is refused plainly, and the file is left as it was', async () => {
    await seed('{ "permissions": { "allow": [ } ');

    const result = await writeModel({ repoRoot: fork, model: 'sonnet' });

    assert.equal(result.ok, false);
    assert.match(result.error, /settings\.local\.json is not valid JSON/);
    assert.equal(await readFile(local(), 'utf8'), '{ "permissions": { "allow": [ } ');
  });
});

describe('the model the skills declare', () => {
  let plugin;

  before(async () => {
    plugin = await mkdtemp(join(tmpdir(), 'pdkit-session-model-'));
  });

  after(async () => {
    await rm(plugin, { recursive: true, force: true });
  });

  async function skill(name, lines) {
    await mkdir(join(plugin, 'skills', name), { recursive: true });
    await writeFile(join(plugin, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n${lines.join('\n')}\n---\n\nBody.\n`);
  }

  test('the majority of orchestrating skills, counted from frontmatter', async () => {
    await skill('a', ['disable-model-invocation: true', 'model: sonnet']);
    await skill('b', ['disable-model-invocation: true', 'model: sonnet']);
    await skill('c', ['disable-model-invocation: true', 'model: opus']);
    // Phrase-triggered skills are not phases, and do not get a vote.
    await skill('d', ['model: opus']);
    await skill('e', ['model: opus']);

    assert.deepEqual(await sessionModel(plugin), { model: 'sonnet', counts: { sonnet: 2, opus: 1 } });
  });

  test('a tie names no model rather than picking one', async () => {
    await skill('f', ['disable-model-invocation: true', 'model: opus']);

    assert.equal((await sessionModel(plugin)).model, null);
  });

  // Against the real skills/: what init writes today.
  test('the shipped skills give sonnet', async () => {
    assert.equal((await sessionModel()).model, 'sonnet');
  });
});

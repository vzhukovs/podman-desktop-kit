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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptFork } from '../lib/cli.js';

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

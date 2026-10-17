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

// Tests for lib/hooks/scope.js: what proves a command acts outside
// podman-desktop. The repository-backed cases are in test/dispatch.test.js;
// these are the text rules, where an off-by-one in a regular expression is an
// ungated push.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { identities, names, redirection, scope } from '../lib/hooks/scope.js';

const ids = identities({ repo: { upstream: 'podman-desktop/podman-desktop', fork: 'someone/pd-fork' } });

describe('names', () => {
  test('the slugs and the bare name are recognised', () => {
    assert.ok(names('git push git@github.com:podman-desktop/podman-desktop.git', ids));
    assert.ok(names('gh -R someone/pd-fork pr create', ids));
    assert.ok(names('cd ~/src/podman-desktop', ids));
    assert.ok(names('PODMAN-DESKTOP', ids));
  });

  test('a longer name is not podman-desktop', () => {
    assert.equal(names('someone/podman-desktop-kit', ids), false);
    assert.equal(names('podman-desktop_old', ids), false);
  });

  // The case a live push found: a fork that keeps upstream's name, and a
  // project of the same owner whose name starts with it.
  test('a slug is a whole word, not a substring', () => {
    const named = identities({ repo: { upstream: 'podman-desktop/podman-desktop', fork: 'someone/podman-desktop' } });
    assert.equal(names('someone/podman-desktop-kit', named), false);
    assert.equal(names('git@github.com:someone/podman-desktop-kit.git', named), false);
    assert.ok(names('git@github.com:someone/podman-desktop.git', named));
    assert.equal(names('someone/pd-forked', ids), false);
  });

  test('an empty fork adds nothing, and the name is still known', () => {
    assert.deepEqual(identities({ repo: { upstream: 'podman-desktop/podman-desktop', fork: '' } }), {
      slugs: ['podman-desktop/podman-desktop'],
      names: ['podman-desktop'],
    });
  });
});

describe('redirection', () => {
  for (const [line, found] of [
    ['cd /x && git push', /changes directory/],
    ['pushd /x; git push', /changes directory/],
    ['git -C /x push', /git -C/],
    ['git --work-tree=/x push', /--work-tree/],
    ['GIT_DIR=/x/.git git push', /GIT_DIR/],
    ['GH_REPO=a/b gh pr create', /GH_REPO/],
  ]) {
    test(line, () => assert.match(String(redirection(line, ids)), found));
  }

  test('an ordinary push is not redirected', () => {
    assert.equal(redirection('git push origin main', ids), null);
  });
});

describe('scope', () => {
  test('an environment pointing elsewhere keeps the gate on', async () => {
    const where = await scope({ commandLine: 'git push', cwd: process.cwd(), env: { GIT_DIR: '/x' }, config: {} });
    assert.equal(where.outside, false);
    assert.match(where.reason, /GIT_DIR/);
  });

  test('a failure is inside, never outside', async () => {
    const where = await scope({ commandLine: 'git push', cwd: '/nonexistent/at/all', env: {}, config: {} });
    assert.equal(where.outside, false);
  });
});

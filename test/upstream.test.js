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

// Tests for lib/upstream.js.
//
// These rules are shared between the hooks that enforce them live and the
// preflight checks that verify them in batch, so a wrong answer here shows up
// twice: as a hook that passes what preflight rejects, or as preflight
// blocking a PR that upstream would have accepted. The second is worse. It is
// invisible until someone gives up on the tool.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMIT_TYPES,
  EXTENSION_API_DTS,
  SPDX_REQUIRED_EXTENSIONS,
  checkSpdx,
  classifyApiSurface,
  parseCommitSubject,
  spdxHeader,
  validateCommit,
} from '../lib/upstream.js';

/** The header as podman-desktop writes it, years and all. */
const HOUSE_HEADER = `/${'*'.repeat(70)}
 * Copyright (C) 2022-2026 Red Hat, Inc.
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
 ${'*'.repeat(71)}/
`;

describe('checkSpdx', () => {
  test('the house header counts', () => {
    const result = checkSpdx({ path: 'packages/main/src/x.ts', content: `${HOUSE_HEADER}export const x = 1;\n` });
    assert.deepEqual(result, { required: true, present: true, insert: null });
  });

  // The finding stage 0 made: the repository's format is the block, not the
  // line. Accepting the line would teach the hook to pass what review rejects.
  test('a bare identifier line is not the repository format', () => {
    const result = checkSpdx({
      path: 'packages/main/src/x.ts',
      content: '// SPDX-License-Identifier: Apache-2.0\nexport const x = 1;\n',
    });
    assert.equal(result.present, false);
    assert.ok(result.insert.includes('Red Hat, Inc.'));
  });

  test('every way the year is written is accepted', () => {
    for (const year of ['2024', '2022-2024', '2022, 2024', '2022 - 2024']) {
      const content = HOUSE_HEADER.replace('2022-2026', year);
      assert.equal(
        checkSpdx({ path: 'packages/main/src/x.ts', content }).present,
        true,
        `"Copyright (C) ${year} Red Hat, Inc." should be accepted`,
      );
    }
  });

  // Measured against the repository: .svelte is 0 of 589 and .css 0 of 5. The
  // skeleton required both, which would have blocked every new Svelte
  // component — and UI work is mostly Svelte components.
  test('svelte and css do not need a header', () => {
    for (const path of ['packages/ui/src/lib/Button.svelte', 'packages/renderer/src/app.css']) {
      const result = checkSpdx({ path, content: '<div/>' });
      assert.equal(result.required, false, `${path} should not require a header`);
      assert.equal(result.insert, null);
    }
    assert.ok(!SPDX_REQUIRED_EXTENSIONS.includes('.svelte'));
    assert.ok(!SPDX_REQUIRED_EXTENSIONS.includes('.css'));
  });

  test('the generated header is itself valid', () => {
    const generated = spdxHeader(2026);
    assert.equal(checkSpdx({ path: 'x.ts', content: generated }).present, true);
    assert.match(generated, /Copyright \(C\) 2026 Red Hat, Inc\./);
  });
});

describe('parseCommitSubject', () => {
  test('reads type, scope, description and the breaking marker', () => {
    assert.deepEqual(parseCommitSubject('feat(main): add x'), {
      type: 'feat',
      scope: 'main',
      description: 'add x',
      breaking: false,
    });
    assert.deepEqual(parseCommitSubject('fix: bump x'), {
      type: 'fix',
      scope: null,
      description: 'bump x',
      breaking: false,
    });
    assert.equal(parseCommitSubject('feat(extension-api)!: drop y').breaking, true);
    assert.equal(parseCommitSubject('feat!: drop y').breaking, true);
  });

  test('returns null for what is not a conventional subject', () => {
    for (const subject of ['just a message', 'feat add x', '', 'WIP']) {
      assert.equal(parseCommitSubject(subject), null, `"${subject}" should not parse`);
    }
  });
});

describe('validateCommit', () => {
  const signed = { 'Signed-off-by': ['Test <test@example.com>'] };

  test('a well-formed commit passes', () => {
    const result = validateCommit({ subject: 'fix(main): guard the empty case', trailers: signed });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  });

  // The 0.3 correction. Blocking on a missing scope would reject work upstream
  // accepts every week, and would make /pd:review-pr complain about other
  // people's PRs for following their own repository's rules.
  test('a missing scope is a note, not a problem', () => {
    const result = validateCommit({ subject: 'fix: guard the empty case', trailers: signed });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /does not require one/);
  });

  test('an unknown type is a problem', () => {
    const result = validateCommit({ subject: 'improve(main): things', trailers: signed });
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /not one of the accepted types/);
  });

  test('a subject that is not conventional at all is a problem', () => {
    assert.equal(validateCommit({ subject: 'fixed the bug', trailers: signed }).ok, false);
  });

  test('a missing sign-off is a problem', () => {
    const result = validateCommit({ subject: 'fix(main): x', trailers: {} });
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /Signed-off-by/);
  });

  // What `git rebase -i` produces when squashing signed commits, and what the
  // husky hook then rejects. The message has to name the alternative or it
  // gets retried the same way.
  test('two sign-offs are a problem, and the message says what to do instead', () => {
    const result = validateCommit({
      subject: 'fix(main): x',
      trailers: { 'Signed-off-by': ['A <a@b>', 'A <a@b>'] },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /reset --soft/);
  });

  test('revert is accepted because commitlint accepts it', () => {
    assert.ok(COMMIT_TYPES.includes('revert'));
    assert.equal(validateCommit({ subject: 'revert: undo x', trailers: signed }).ok, true);
  });
});

describe('classifyApiSurface', () => {
  let repo;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'pdkit-upstream-'));
    await mkdir(join(repo, 'packages', 'extension-api', 'src'), { recursive: true });
    await writeFile(
      join(repo, EXTENSION_API_DTS),
      [
        'declare module "@podman-desktop/api" {',
        '  export interface RunOptions {',
        '    env?: { [key: string]: string };',
        '  }',
        '  export function exec(command: string, options?: RunOptions): Promise<void>;',
        '}',
        '',
      ].join('\n'),
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // The trap itself: RunOptions lives in packages/main/src/plugin/util/exec.ts
  // and reads as an internal helper, while also being declared here.
  test('a type declared in the public surface is public, with a location', async () => {
    const [result] = await classifyApiSurface({ symbols: ['RunOptions'], repoRoot: repo });

    assert.equal(result.public, true);
    assert.equal(result.declaredAt, `${EXTENSION_API_DTS}:2`);
  });

  test('a type that is nowhere in the surface is internal', async () => {
    const [result] = await classifyApiSurface({ symbols: ['InternalHelper'], repoRoot: repo });

    assert.equal(result.public, false);
    assert.equal(result.declaredAt, null);
  });

  // Substring matching would call "Options" public because "RunOptions"
  // contains it, and then every PR touching anything named Options would be
  // told it changed the public API.
  test('matching is on whole words', async () => {
    const [result] = await classifyApiSurface({ symbols: ['Options'], repoRoot: repo });
    assert.equal(result.public, false);
  });

  test('no surface file means nothing is public, rather than an error', async () => {
    const results = await classifyApiSurface({ symbols: ['RunOptions'], repoRoot: '/definitely/not/here' });
    assert.deepEqual(results, [{ symbol: 'RunOptions', public: false, declaredAt: null }]);
  });

  test('no symbols is no work', async () => {
    assert.deepEqual(await classifyApiSurface({ symbols: [], repoRoot: repo }), []);
  });
});

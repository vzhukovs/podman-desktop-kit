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

// The post-claim hook: a name written down as missing that the codebase does
// not contain under that name.
//
// What it protects: a design document asked whether to add a field under the
// name a reference project uses. The field existed under another name, and
// the zero for the borrowed name had been read as absence. The fixture repo
// below has the local name and not the borrowed one, which is that situation.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claims, handle, occurring } from '../lib/hooks/post-claim.js';

let repo;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pdkit-post-claim-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  await writeFile(
    join(repo, 'api.d.ts'),
    'export namespace env {\n  export const appName: string;\n  export const urlProtocol: string;\n}\n',
  );
  await writeFile(join(repo, 'design.md'), 'Add `env.uriScheme` here.\n');
  git('add', '.');
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

const context = (overrides = {}) => ({
  event: 'post-claim',
  pluginRoot: '/plugin',
  findRepo: async () => repo,
  ...overrides,
});

const write = (filePath, content) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

describe('claims', () => {
  test('takes a dotted name from a sentence that proposes adding it', () => {
    const text = '(f) policy for first run; (g) whether `env.uriScheme` should be added for extensions that build links.';
    assert.deepEqual(
      claims(text).map((claim) => [claim.name, claim.leaf]),
      [['env.uriScheme', 'uriScheme']],
    );
  });

  test('takes a bare name only when the sentence says it is missing', () => {
    assert.deepEqual(claims('There is no `urlProtocol` in the API.').map((claim) => claim.name), ['urlProtocol']);
    // A proposal of new code names something that is supposed not to exist yet.
    assert.deepEqual(claims('Add a new `DeepLinkDispatcher` class.'), []);
  });

  test('ignores paths, commands, short leaves and neutral sentences', () => {
    assert.deepEqual(claims('There is no `packages/main/src/x.ts` file.'), []);
    assert.deepEqual(claims('There is no `--force` flag.'), []);
    assert.deepEqual(claims('Add `env.id` later.'), []);
    assert.deepEqual(claims('`env.urlProtocol` holds the scheme.'), []);
  });

  test('keeps every name, however many a document holds', () => {
    // A cap here is a window: the name this hook exists for was the sixth.
    const text = Array.from({ length: 8 }, (_, i) => `Add \`ns.member${i}\`.`).join(' ');
    assert.equal(claims(text).length, 8);
  });
});

describe('occurring', () => {
  test('returns the names git finds, and none it does not', async () => {
    const found = await occurring(['urlProtocol', 'uriScheme'], repo, 'design.md');
    assert.deepEqual([...found], ['urlProtocol']);
  });

  test('does not count the file being written', async () => {
    assert.deepEqual([...(await occurring(['uriScheme'], repo, null))], ['uriScheme']);
    assert.deepEqual([...(await occurring(['uriScheme'], repo, 'design.md'))], []);
  });

  test('returns null, not an empty set, when git fails', async () => {
    const exec = async () => {
      throw Object.assign(new Error('fatal'), { stdout: '', stderr: 'fatal: not a git repository' });
    };
    assert.equal(await occurring(['uriScheme'], repo, null, { exec }), null);
  });
});

describe('handle', () => {
  test('reminds when a proposed member matches nothing outside the document', async () => {
    const decision = await handle(write(join(repo, 'design.md'), 'Add `env.uriScheme` here.'), context());
    assert.equal(decision.block, false);
    assert.equal(decision.rule, 'name-claim');
    assert.match(decision.message, /`env\.uriScheme`/);
    assert.match(decision.message, /not yet evidence/);
    assert.match(decision.message, /\/plugin\/knowledge\/pitfalls\.md/);
  });

  test('stays quiet when the name is there', async () => {
    const decision = await handle(write(join(repo, 'notes.md'), 'There is no `urlProtocol` yet.'), context());
    assert.deepEqual(decision, { block: false });
  });

  test('stays quiet outside markdown, outside podman-desktop, and when git cannot answer', async () => {
    const text = 'Add `env.uriScheme` here.';
    assert.deepEqual(await handle(write(join(repo, 'a.ts'), text), context()), { block: false });
    assert.deepEqual(await handle(write('/elsewhere/a.md', text), context({ findRepo: async () => null })), {
      block: false,
    });
    const exec = async () => {
      throw Object.assign(new Error('fatal'), { stdout: '', stderr: 'fatal' });
    };
    assert.deepEqual(await handle(write(join(repo, 'a.md'), text), context({ exec })), { block: false });
  });

  test('reads the new text of an Edit', async () => {
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, 'design.md'), old_string: 'x', new_string: 'Add `env.uriScheme`.' },
    };
    assert.equal((await handle(payload, context())).rule, 'name-claim');
  });
});

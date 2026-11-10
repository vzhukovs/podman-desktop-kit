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

// The post-bash hook: a windowed read that stopped inside a block.
//
// What it protects: an API member past the end of a `grep -A` window was read
// as absent, and an analysis proposed adding a field the API already had. The
// cases below are that shape — a namespace cut before its last members — and
// the shapes that must stay quiet, because a reminder on every windowed read
// is a reminder nobody reads.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { braces } from '../lib/hooks/cut.js';
import { handle, windows } from '../lib/hooks/post-bash.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'pdkit');

/** A namespace cut by the window before its last members and its brace. */
const CUT_NAMESPACE = [
  '4522:  export namespace env {',
  '4526-    export const appName: string;',
  '4570-    export function openExternal(uri: Uri): Promise<boolean>;',
  '4579-    export function createTelemetryLogger(sender?: TelemetrySender): TelemetryLogger;',
].join('\n');

/** The same namespace read to its end. */
const WHOLE_NAMESPACE = `${CUT_NAMESPACE}\n4590-    export const urlProtocol: string;\n4591-  }`;

const payload = (command, stdout) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false },
});

const context = { event: 'post-bash', pluginRoot: '/plugin' };

describe('windows', () => {
  test('finds the context window on grep, also behind a pipe', () => {
    assert.deepEqual(windows('grep -n "export namespace env" -A60 api.d.ts | grep -n export | head -30'), [
      'grep -A60',
    ]);
  });

  test('counts head only when it reads a file itself', () => {
    assert.deepEqual(windows('head -40 api.d.ts'), ['head -40']);
    assert.deepEqual(windows('head -n 40 api.d.ts'), ['head -n 40']);
    // Trimming a list of matched lines is not reading a block.
    assert.deepEqual(windows('grep -n "start() {" loader.ts | head -15'), []);
  });

  test('counts head and tail piped straight from a file printer', () => {
    // `cat f | head` cuts the file exactly as `head f` does.
    assert.deepEqual(windows('cat api.d.ts | head -100'), ['head -100']);
    assert.deepEqual(windows('cat -n api.d.ts | head -n 100'), ['head -n 100']);
    assert.deepEqual(windows('git show HEAD:api.d.ts | tail -80'), ['tail -80']);
    // A search between them makes it a list of matches again; a `;` is no pipe.
    assert.deepEqual(windows('cat api.d.ts | grep export | head -5'), []);
    assert.deepEqual(windows('cat a.ts; grep x f | head'), []);
  });

  test('reads clustered and separated context options, and git grep', () => {
    assert.deepEqual(windows('git grep -nA5 foo'), ['git grep -nA5']);
    assert.deepEqual(windows('rg -C 3 foo'), ['rg -C 3']);
    assert.deepEqual(windows('grep --after-context=8 foo f'), ['grep --after-context=8']);
  });

  test('finds sed ranges, awk line ranges and bare head', () => {
    assert.deepEqual(windows('sed -n 1555,1600p a.ts'), ['sed -n 1555,1600p']);
    assert.deepEqual(windows("awk 'NR>=10 && NR<=20' f"), ["awk 'NR>=10 && NR<=20'"]);
    assert.deepEqual(windows('head f'), ['head']);
  });

  test('is quiet on reads with no window', () => {
    assert.deepEqual(windows('cat api.d.ts'), []);
    assert.deepEqual(windows('grep -c foo f'), []);
    assert.deepEqual(windows('sed -i s/a/b/ f'), []);
    // Following a log is watching, not reading a block.
    assert.deepEqual(windows('tail -f app.log'), []);
  });
});

describe('braces', () => {
  test('counts what the text leaves open', () => {
    assert.deepEqual(braces(CUT_NAMESPACE), { opened: 1, closed: 0 });
    assert.deepEqual(braces(WHOLE_NAMESPACE), { opened: 1, closed: 1 });
  });
});

describe('handle', () => {
  test('puts the rule beside a windowed read that ends inside a block', async () => {
    const decision = await handle(payload('grep -n "namespace env" -A60 api.d.ts', CUT_NAMESPACE), context);
    assert.equal(decision.block, false);
    assert.equal(decision.rule, 'cut-read');
    assert.match(decision.message, /`grep -A60`/);
    assert.match(decision.message, /1 `\{` opened, 0 closed/);
    assert.match(decision.message, /unread, not absent/);
    assert.match(decision.message, /\/plugin\/knowledge\/pitfalls\.md/);
  });

  test('stays quiet when the window reached the closing brace', async () => {
    const decision = await handle(payload('grep -n "namespace env" -A70 api.d.ts', WHOLE_NAMESPACE), context);
    assert.deepEqual(decision, { block: false });
  });

  test('stays quiet on an unwindowed read, however open its output', async () => {
    const decision = await handle(payload('cat api.d.ts', CUT_NAMESPACE), context);
    assert.deepEqual(decision, { block: false });
  });

  test('ignores other tools and empty payloads', async () => {
    assert.deepEqual(await handle({ tool_name: 'Read', tool_input: {} }, context), { block: false });
    assert.deepEqual(await handle(null, context), { block: false });
  });
});

describe('through bin/pdkit', () => {
  // The handler can be right while nothing reaches the model: after a tool,
  // Claude Code drops plain stdout into the debug log and passes on only
  // additionalContext. This runs the real binary and reads what it prints.
  test('the message reaches the host as additionalContext', () => {
    const run = spawnSync('node', [BIN, 'hook', 'post-bash'], {
      input: JSON.stringify(payload('sed -n 1555,1600p loader.ts', CUT_NAMESPACE)),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /`sed -n 1555,1600p`/);
  });
});

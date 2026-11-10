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

// The post-read hook: a Read or a Grep that stopped inside a block.
//
// What it protects: the same miss post-bash exists for, made through the
// tools the model is told to prefer. A plain Read of a long declaration file
// returns its first 2000 lines, and the newest namespace members are past
// them. The payload shapes are Claude Code's documented tool responses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { grepWindows, handle, readWindow } from '../lib/hooks/post-read.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'pdkit');

const CUT = ['  export namespace env {', '    export const appName: string;'].join('\n');
const WHOLE = `${CUT}\n    export const urlProtocol: string;\n  }`;

const read = (file) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/repo/api.d.ts' },
  tool_response: { type: 'text', file: { filePath: '/repo/api.d.ts', ...file } },
});

const grep = (input, response) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Grep',
  tool_input: { pattern: 'namespace env', output_mode: 'content', ...input },
  tool_response: { mode: 'content', numFiles: 0, filenames: [], ...response },
});

const context = { event: 'post-read', pluginRoot: '/plugin' };

describe('readWindow', () => {
  test('names the lines a partial Read returned', () => {
    assert.equal(readWindow({ startLine: 1, numLines: 2000, totalLines: 4700 }), 'Read lines 1-2000 of 4700');
    assert.equal(readWindow({ startLine: 4500, numLines: 60, totalLines: 4700 }), 'Read lines 4500-4559 of 4700');
  });

  test('is null for a whole file, and counts a token-capped one as cut', () => {
    assert.equal(readWindow({ startLine: 1, numLines: 120, totalLines: 120 }), null);
    assert.equal(
      readWindow({ startLine: 1, numLines: 120, totalLines: 120, truncatedByTokenCap: true }),
      'Read lines 1-120 of 120',
    );
  });
});

describe('grepWindows', () => {
  test('names context options and an applied cap', () => {
    assert.deepEqual(grepWindows({ '-A': 60 }, {}), ['Grep -A 60']);
    assert.deepEqual(grepWindows({ context: 5 }, { appliedLimit: 30 }), ['Grep -C 5', 'Grep head_limit 30']);
    assert.deepEqual(grepWindows({}, {}), []);
  });
});

describe('handle', () => {
  test('puts the rule beside a partial Read that ends inside a block', async () => {
    const decision = await handle(read({ content: CUT, startLine: 1, numLines: 2000, totalLines: 4700 }), context);
    assert.equal(decision.rule, 'cut-read');
    assert.match(decision.message, /`Read lines 1-2000 of 4700`/);
    assert.match(decision.message, /unread, not absent/);
  });

  test('stays quiet on a whole-file Read, and on a partial one that closed its block', async () => {
    const whole = read({ content: CUT, startLine: 1, numLines: 2, totalLines: 2 });
    const closed = read({ content: WHOLE, startLine: 4500, numLines: 4, totalLines: 4700 });
    assert.deepEqual(await handle(whole, context), { block: false });
    assert.deepEqual(await handle(closed, context), { block: false });
  });

  test('puts the rule beside a Grep with context that ends inside a block', async () => {
    const decision = await handle(grep({ '-A': 60 }, { content: CUT, numLines: 2 }), context);
    assert.match(decision.message, /`Grep -A 60`/);
  });

  test('stays quiet on a Grep with no window, and outside content mode', async () => {
    assert.deepEqual(await handle(grep({}, { content: CUT }), context), { block: false });
    assert.deepEqual(
      await handle(grep({ '-A': 60, output_mode: 'files_with_matches' }, { mode: 'files_with_matches', filenames: ['a'] }), context),
      { block: false },
    );
  });

  test('ignores other tools and empty payloads', async () => {
    assert.deepEqual(await handle({ tool_name: 'Bash', tool_input: {} }, context), { block: false });
    assert.deepEqual(await handle(null, context), { block: false });
  });
});

describe('through bin/pdkit', () => {
  test('the message reaches the host as additionalContext', () => {
    const run = spawnSync('node', [BIN, 'hook', 'post-read'], {
      input: JSON.stringify(read({ content: CUT, startLine: 1, numLines: 2000, totalLines: 4700 })),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /`Read lines 1-2000 of 4700`/);
  });
});

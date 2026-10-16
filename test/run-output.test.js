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

// What a command that captured a run prints about it.
//
// `receipt write`, `validate run` and `e2e stability` used to print the run
// whole, and it stayed in the session's context: receipts of 450 KB, three
// Playwright runs of 170 KB each. The file keeps all of it; the terminal gets
// the path, and the tail only when there is a failure to read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FAILURE_TAIL_LINES, describeRun } from '../lib/cli.js';

/** @param {Partial<import('../lib/evidence.js').Capture>} over */
function capture(over) {
  return {
    command: 'pnpm test',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1234,
    at: '2026-10-16T00:00:00.000Z',
    complete: true,
    ...over,
  };
}

const LONG = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');

describe('describeRun', () => {
  test('a green run is the path, the exit code, the duration and the digest — nothing of the output', () => {
    const text = describeRun({ path: '/x/receipts/T1.md', run: capture({ stdout: LONG }), digest: 'sha256:abc' });

    assert.equal(text, '/x/receipts/T1.md\n  exit 0, 1234ms, sha256:abc\n');
  });

  test('a red run adds the last lines, because that is where the assertion failed', () => {
    const text = describeRun({ path: '/x/T1.md', run: capture({ exitCode: 1, stdout: `${LONG}\n` }), digest: 'sha256:abc' });
    const shown = text.split('\n').filter((line) => line.startsWith('  | '));

    assert.equal(shown.length, FAILURE_TAIL_LINES);
    assert.equal(shown.at(-1), '  | line 5000');
    assert.equal(shown[0], `  | line ${5000 - FAILURE_TAIL_LINES + 1}`);
    assert.match(text, /last 40 of 5000 lines; the rest is in the file/);
  });

  test('a short red run is shown whole and says so', () => {
    const text = describeRun({ path: '/x/T1.md', run: capture({ exitCode: 2, stdout: 'a\n', stderr: 'b\n' }), digest: 'sha256:abc' });

    assert.match(text, /the whole run; the rest is in the file:\n {2}\| a\n {2}\| b\n$/);
  });

  test('a killed run says it was killed and why the capture is not whole', () => {
    const text = describeRun({
      path: '/x/T1.md',
      run: capture({ exitCode: null, complete: false, incompleteBecause: 'timed out after 600000ms', stdout: 'x' }),
      digest: 'sha256:abc',
    });

    assert.match(text, /exit none — killed/);
    assert.match(text, /capture incomplete — timed out/);
    assert.match(text, /\| x/);
  });
});

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

// The one property every hook has to have: it ends.
//
// This is asserted against the real binary rather than against a function,
// because the defect it guards lived between the two. `readHookPayload` was
// four correct-looking lines, every handler had tests, and the first time the
// plugin was installed for real it hung Claude Code at startup — the read
// waited for the END of stdin while what a hook needs is the payload, and a
// host that writes the JSON and keeps the pipe open is an ordinary host.
//
// Two things had to be true for that to happen, so both are pinned here: the
// decision has to be reached without waiting for the writer, and the process
// has to exit afterwards. `bin/pdkit` sets `process.exitCode` and returns, so a
// stream still attached keeps the event loop alive all by itself — a handler
// that decides in sixty milliseconds and never exits is the same hang.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');

/**
 * Run a hook with a pipe that is never closed, and see whether it ends anyway.
 *
 * @param {{event: string, payload?: string, limitMs?: number}} input
 * @returns {Promise<{code: number|null, ms: number, output: string, killed: boolean}>}
 */
function hookWithOpenStdin(input) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('node', [BIN, 'hook', input.event], { stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));

    if (input.payload !== undefined) child.stdin.write(input.payload);
    // Deliberately not ended. That is the whole test.

    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, ms: Date.now() - started, output, killed: true });
    }, input.limitMs ?? 6000);

    child.on('exit', (code) => {
      clearTimeout(guard);
      resolve({ code, ms: Date.now() - started, output, killed: false });
    });
  });
}

describe('a hook whose stdin is never closed', () => {
  test('answers as soon as the payload is whole, without waiting for the writer', async () => {
    const run = await hookWithOpenStdin({
      event: 'post-write',
      payload: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/nothing-interesting.txt' } }),
    });

    assert.equal(run.killed, false, 'the hook never returned: this is the startup hang');
    assert.equal(run.code, 0);
    // Measured at ~60ms. The bound is loose because this spawns node; what it
    // rules out is waiting on the writer, which was five seconds and then
    // forever.
    assert.ok(run.ms < 1500, `took ${run.ms}ms, which means it waited for something other than the payload`);
  });

  test('a host that sends nothing costs a pause, not the session', async () => {
    const run = await hookWithOpenStdin({ event: 'post-write', limitMs: 8000 });

    assert.equal(run.killed, false, 'a hook with no payload has to give up rather than wait');
    // It says so, rather than proceeding as though stdin had simply been empty:
    // "nothing was sent" and "nothing has been sent yet" are different facts,
    // and for the fail-closed event the difference is the gate.
    assert.match(run.output, /waited \d+ms for its payload/);
  });

  test('the gate still refuses through a pipe that stays open', async () => {
    const run = await hookWithOpenStdin({
      event: 'pre-bash',
      payload: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }),
    });

    assert.equal(run.killed, false);
    assert.equal(run.code, 2, 'exit 2 is how a hook refuses; anything else lets the push through');
    assert.ok(run.ms < 1500, `took ${run.ms}ms`);
  });
});

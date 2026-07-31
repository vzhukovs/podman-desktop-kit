// SPDX-License-Identifier: Apache-2.0

// Tests for lib/evidence.js.
//
// The property being defended is that captured output is the real thing. A
// capture that lost its tail still looks like proof, which makes it worse than
// no capture at all — so the cases that matter here are the ones where the
// output is not what the command produced, and whether the record says so.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EVIDENCE_ENV, capture } from '../lib/evidence.js';

describe('capture', () => {
  test('records stdout, the exit code and how long it took', async () => {
    const result = await capture({ command: 'echo hello' });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello\n');
    assert.equal(result.complete, true);
    assert.ok(result.durationMs >= 0);
    assert.ok(Date.parse(result.at) > 0);
    assert.equal(result.command, 'echo hello');
  });

  // A failing test run is exactly what preflight has to show. Throwing here
  // would mean the one output most worth attaching is the one never captured.
  test('a non-zero exit is a result, not a failure', async () => {
    const result = await capture({ command: 'echo out; echo err 1>&2; exit 3' });

    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'out\n');
    assert.equal(result.stderr, 'err\n');
    assert.equal(result.complete, true);
  });

  test('output is captured verbatim, not trimmed or reformatted', async () => {
    const result = await capture({ command: "printf 'a\\n\\n  b   \\n'" });
    assert.equal(result.stdout, 'a\n\n  b   \n');
  });

  test('runs in the directory it is given', async () => {
    const result = await capture({ command: 'pwd', cwd: '/tmp' });
    assert.match(result.stdout.trim(), /tmp$/);
  });

  // Section 8.2: what makes a receipt evidence rather than a claim is that the
  // output was not compressed on its way here.
  test('rtk is disabled for the run', async () => {
    const result = await capture({ command: 'echo "RTK_DISABLE=$RTK_DISABLE"' });

    assert.equal(EVIDENCE_ENV.RTK_DISABLE, '1');
    assert.equal(result.stdout.trim(), 'RTK_DISABLE=1');
  });

  test('a timeout is reported as incomplete rather than as a clean result', async () => {
    const result = await capture({ command: 'echo started; sleep 5', timeoutMs: 150 });

    assert.equal(result.complete, false);
    assert.match(result.incompleteBecause, /killed by/);
    // The exit code is not 0: a killed run must never read as a pass.
    assert.notEqual(result.exitCode, 0);
  });

  test('an empty command is refused rather than run', async () => {
    await assert.rejects(() => capture({ command: '   ' }), /no command/);
  });
});

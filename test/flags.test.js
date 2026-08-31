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

// Contract for the unknown-flag check in lib/cli.js.
//
// `parseArgs` accepts any `--word` and hands it over; until this check existed
// nothing asked whether the command reads it. The failure that produced this
// file is in the first case below: two flags, two exit codes of zero, two
// summaries printed without the thing that was asked for.
//
// The cost is highest exactly where it is least visible. A misspelt `--force`
// or `--confirm` is a command that ran without the thing the person typed it
// for, and reads as success.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { unknownFlags } from '../lib/cli.js';

describe('unknown flags', () => {
  // The live run, on the first issue this plugin took end to end: `issue fetch`
  // does not take a body flag, printed the summary, exited 0, and the session
  // tried a second spelling before giving up and calling gh directly.
  test('a flag the command does not read is reported', () => {
    assert.deepEqual(
      unknownFlags('issue', { body: true }).map((entry) => entry.name),
      ['body'],
    );
    assert.deepEqual(
      unknownFlags('issue', { full: true }).map((entry) => entry.name),
      ['full'],
    );
  });

  test('flags the command does read are not', () => {
    assert.deepEqual(unknownFlags('issue', { label: 'a,b', limit: '20' }), []);
    assert.deepEqual(unknownFlags('pr', { issue: '1', branch: 'b', base: 'main', title: 't', body: 'f' }), []);
  });

  test('the four global flags are accepted everywhere', () => {
    for (const command of ['init', 'knowledge', 'plan', 'stats', 'pr']) {
      assert.deepEqual(unknownFlags(command, { json: true, repo: '/tmp', help: true, h: true }), [], command);
    }
  });

  // The table is per command, so a flag that exists on a neighbour is still
  // wrong here — which is the whole point of not having one global list.
  test('a flag that belongs to another command is still unknown', () => {
    assert.equal(unknownFlags('e2e', { runs: '3' }).length, 0);
    assert.equal(unknownFlags('validate', { runs: '3' }).length, 1, 'runs is e2e stability, not validate');
    assert.equal(unknownFlags('close', { confirm: true }).length, 1, 'close takes --finish; --confirm is reset');
    assert.equal(unknownFlags('reset', { confirm: true }).length, 0);
  });

  // Section 2.2, invariant 5: the outcome of a validation step comes from what
  // was attached. The usage text has said "there is no --status" since stage 5,
  // and until now the CLI took one and ignored it — the documentation was the
  // only thing enforcing the invariant.
  test('validate has no --status, and now says so', () => {
    const [refused] = unknownFlags('validate', { status: 'pass' });

    assert.equal(refused.name, 'status');
    assert.deepEqual(unknownFlags('validate', { evidence: 'shot.png', observed: 'the list refreshed' }), []);
  });

  test('a near miss suggests the flag it is near', () => {
    assert.equal(unknownFlags('worktree', { brnach: 'x' })[0].suggestion, 'branch');
    assert.equal(unknownFlags('slice', { slic: '1' })[0].suggestion, 'slice');
  });

  // A suggestion that fits anything helps with nothing: two edits from "b"
  // reaches half the table.
  test('a flag that resembles nothing suggests nothing', () => {
    assert.equal(unknownFlags('issue', { body: true })[0].suggestion, null);
    assert.equal(unknownFlags('init', { b: true })[0].suggestion, null, 'a one-letter flag is within two of everything');
  });

  // Invoked by the host rather than typed. Refusing an argument a future
  // Claude Code adds would take the gate down to report a typo nobody made.
  test('hook is exempt, and so is a command that does not exist', () => {
    assert.deepEqual(unknownFlags('hook', { anything: true, later: true }), []);
    assert.deepEqual(unknownFlags('nonsense', { whatever: true }), [], 'the unknown command is the error, not its flags');
  });

  test('every unknown flag is named, not just the first', () => {
    assert.deepEqual(
      unknownFlags('packages', { one: true, two: true }).map((entry) => entry.name),
      ['one', 'two'],
    );
  });
});

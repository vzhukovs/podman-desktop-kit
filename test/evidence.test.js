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

// Tests for lib/evidence.js.
//
// The property being defended is that captured output is the real thing. A
// capture that lost its tail still looks like proof, which makes it worse than
// no capture at all — so the cases that matter here are the ones where the
// output is not what the command produced, and whether the record says so.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capture, digest, fence, transcript, validateReceipt, writeReceipt } from '../lib/evidence.js';

// `node -e "…"` rather than `echo`, `printf`, `pwd` and `sleep`.
//
// capture() hands the command to the platform shell, which is the behaviour
// under test and is correct: a `Done when` command is whatever the repository's
// scripts are. But the shell is `/bin/sh` on POSIX and `cmd.exe` on Windows, and
// the fixtures were written in one of those two languages — `;` is not a
// separator in cmd, `pwd`, `printf` and `seq` do not exist there, and `echo`
// emits CRLF. Every one of these failed on the first Windows run.
//
// Node is the one interpreter guaranteed present, since it is running this
// suite. The quoting works out on both shells too: double quotes are what cmd
// understands, and inside them `sh` leaves a backslash alone unless it precedes
// `$`, a backtick, a quote or another backslash — so `\n` reaches node either
// way and node reads it as the escape. What the assertions gain is exactness:
// they now describe bytes this suite chose rather than what a shell builtin
// happens to print.
describe('capture', () => {
  test('records stdout, the exit code and how long it took', async () => {
    const command = 'node -e "process.stdout.write(\'hello\\n\')"';
    const result = await capture({ command });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello\n');
    assert.equal(result.complete, true);
    assert.ok(result.durationMs >= 0);
    assert.ok(Date.parse(result.at) > 0);
    assert.equal(result.command, command);
  });

  // A failing test run is exactly what preflight has to show. Throwing here
  // would mean the one output most worth attaching is the one never captured.
  test('a non-zero exit is a result, not a failure', async () => {
    const result = await capture({
      command: 'node -e "process.stdout.write(\'out\\n\');process.stderr.write(\'err\\n\');process.exit(3)"',
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'out\n');
    assert.equal(result.stderr, 'err\n');
    assert.equal(result.complete, true);
  });

  test('output is captured verbatim, not trimmed or reformatted', async () => {
    const result = await capture({ command: 'node -e "process.stdout.write(\'a\\n\\n  b   \\n\')"' });
    assert.equal(result.stdout, 'a\n\n  b   \n');
  });

  test('runs in the directory it is given', async () => {
    // The system temp directory rather than a literal /tmp, which Windows has
    // no equivalent of; and realpath because macOS reports it through a symlink.
    const where = await realpath(tmpdir());
    const result = await capture({ command: 'node -e "process.stdout.write(process.cwd())"', cwd: where });

    assert.equal(await realpath(result.stdout.trim()), where);
  });

  // What makes a receipt evidence rather than a claim is that the output was not
  // rewritten on its way here (section 6, receipts).
  //
  // The guarantee is the spawn. capture() starts the process from Node, so an
  // output rewriter hooked onto Claude Code's Bash tool never sees the command.
  // These two assert the property that follows from it, which is the one worth
  // keeping whether or not any such rewriter is ever installed: bulk arrives
  // whole, and the command is the one the receipt names.
  //
  // An earlier pair of tests asserted an opt-out environment variable instead —
  // first against a constant this module declared itself, then from inside the
  // child process. Both only ever proved the variable was set. The variable
  // turned out to do nothing, and neither test could have said so.
  test('output a compressor would fold arrives whole', async () => {
    const lines = 500;
    const result = await capture({
      command: `node -e "for(let i=1;i<=${lines};i++)process.stdout.write('ok '+i+'\\n')"`,
    });

    assert.equal(result.stdout.split('\n').filter(Boolean).length, lines);
    assert.match(result.stdout, /^ok 1\n/);
    assert.match(result.stdout, new RegExp(`ok ${lines}\\n$`));
    assert.equal(result.complete, true);
  });

  // The command is handed to the shell as written. Any layer that rewrote it on
  // the way would have to change this string, and the receipt would then name a
  // command nobody ran.
  test('the command is run and recorded exactly as given', async () => {
    // Still a pipe, because a rewriter would have to survive one, and still
    // shell syntax rather than a single program — `|` is the one operator both
    // shells spell the same way.
    const command =
      'node -e "process.stdout.write(\'one\\ntwo\\nthree\\n\')" | ' +
      'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>' +
      'process.stdout.write(d.split(\'\\n\').filter(Boolean).slice(-2).join(\'\\n\')+\'\\n\'))"';
    const result = await capture({ command });

    assert.equal(result.command, command);
    assert.equal(result.stdout, 'two\nthree\n');
  });

  test('a timeout is reported as incomplete rather than as a clean result', async () => {
    const result = await capture({
      command: 'node -e "process.stdout.write(\'started\\n\');setTimeout(()=>{},5000)"',
      timeoutMs: 150,
    });

    assert.equal(result.complete, false);
    assert.match(result.incompleteBecause, /killed by/);
    // The exit code is not 0: a killed run must never read as a pass.
    assert.notEqual(result.exitCode, 0);
  });

  test('an empty command is refused rather than run', async () => {
    await assert.rejects(() => capture({ command: '   ' }), /no command/);
  });
});

describe('fencing a transcript', () => {
  // Test output contains fenced code often enough that a fixed three-backtick
  // fence would break the file rather than the argument, and an Output block
  // that ends early is one that lost its tail while still looking whole.
  test('the fence is longer than any run of backticks inside it', () => {
    const fenced = fence('a\n```\nb\n');

    assert.ok(fenced.startsWith('````\n'));
    assert.ok(fenced.endsWith('\n````'));
  });

  test('three backticks are enough for ordinary output', () => {
    assert.ok(fence('plain\n').startsWith('```\n'));
  });

  test('a transcript always ends with a newline', () => {
    const run = { command: 'printf x', stdout: 'x', stderr: '', exitCode: 0 };
    assert.equal(transcript(run), '$ printf x\nx\n');
  });
});

describe('receipts', () => {
  let home;

  /**
   * @param {{command?: string, stdout?: string, stderr?: string, exitCode?: number|null, complete?: boolean, incompleteBecause?: string}} [over]
   */
  const run = (over = {}) => ({
    command: 'pnpm test:main',
    exitCode: 0,
    stdout: 'Test Files  1 passed (1)\n',
    stderr: '',
    durationMs: 4210,
    at: '2026-07-31T10:00:00.000Z',
    complete: true,
    ...over,
  });

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-receipt-'));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('a written receipt validates', async () => {
    const written = await writeReceipt({ issue: 18248, taskId: 'T1', run: run(), files: ['a.ts'], home });
    const checked = validateReceipt(await readFile(written.path, 'utf8'));

    assert.equal(checked.ok, true, checked.reason);
    assert.equal(checked.exitCode, 0);
    assert.equal(checked.command, 'pnpm test:main');
  });

  test('the captured output is in the file verbatim', async () => {
    const written = await writeReceipt({ issue: 18248, taskId: 'T2', run: run({ stdout: 'a\n\n  spaced   \n' }), home });
    const content = await readFile(written.path, 'utf8');

    assert.match(content, /\$ pnpm test:main\na\n\n {2}spaced {3}\n/);
  });

  // The receipt worth having most. A red run is how a task reports that it is
  // not done, and a validator that refused red receipts would make them the
  // ones it pays not to write. Deciding "not done" is the hook's job.
  test('a failing run produces a valid receipt', async () => {
    const written = await writeReceipt({
      issue: 18248,
      taskId: 'T3',
      run: run({ exitCode: 1, stderr: '18 unhandled errors\n' }),
      home,
    });
    const checked = validateReceipt(await readFile(written.path, 'utf8'));

    assert.equal(checked.ok, true, checked.reason);
    assert.equal(checked.exitCode, 1);
  });

  test('output containing a fence survives the round trip', async () => {
    const written = await writeReceipt({ issue: 18248, taskId: 'T4', run: run({ stdout: 'before\n```\nfenced\n```\nafter\n' }), home });
    const checked = validateReceipt(await readFile(written.path, 'utf8'));

    assert.equal(checked.ok, true, checked.reason);
  });

  test('a killed run records that it has no exit code', async () => {
    const written = await writeReceipt({
      issue: 18248,
      taskId: 'T5',
      run: run({ exitCode: null, complete: false, incompleteBecause: 'killed by SIGTERM after 150ms' }),
      home,
    });
    const checked = validateReceipt(await readFile(written.path, 'utf8'));

    assert.equal(checked.ok, false);
    assert.match(checked.reason, /incomplete/);
  });
});

describe('validateReceipt refuses what is not a capture', () => {
  const genuine = (over = {}) => {
    const text = transcript({ command: 'pnpm test:main', stdout: 'ok\n', stderr: '' });
    return [
      '# RECEIPT T1',
      '',
      '- Issue: 18248',
      `- Exit code: ${over.exitCode ?? 0}`,
      '- Duration: 10ms',
      `- Capture: ${over.capture ?? 'complete'}`,
      `- Evidence: ${over.evidence ?? digest(text)} (pdkit 0.1.0)`,
      '',
      '## Command',
      '```bash',
      over.command ?? 'pnpm test:main',
      '```',
      '',
      '## Output',
      fence(over.output ?? text),
      '',
    ].join('\n');
  };

  test('the fixture itself is valid, or the rest of this proves nothing', () => {
    assert.equal(validateReceipt(genuine()).ok, true);
  });

  // The whole point of the digest: pdkit writes the file, so the remaining way
  // to fake a receipt is to edit one afterwards.
  test('output edited after capture is refused', () => {
    const edited = genuine().replace('ok', 'all tests passed');

    const checked = validateReceipt(edited);
    assert.equal(checked.ok, false);
    assert.match(checked.reason, /edited after it was captured/);
  });

  test('a narrative with no captured output is refused', () => {
    const checked = validateReceipt('# RECEIPT T1\n\nI ran the tests and they passed.\n');

    assert.equal(checked.ok, false);
    assert.match(checked.reason, /no fenced Output block/);
  });

  // A hand-written file can have an output block. It cannot have a digest that
  // matches, and it will not have one at all unless somebody set out to forge
  // it — which is a different conversation from an agent taking a shortcut.
  test('an output block with no digest is refused', () => {
    const checked = validateReceipt(genuine().replace(/^- Evidence:.*$/m, ''));

    assert.equal(checked.ok, false);
    assert.match(checked.reason, /no Evidence digest/);
  });

  test('a truncated capture is refused even with a matching digest', () => {
    const checked = validateReceipt(genuine({ capture: 'incomplete — output exceeded 32 bytes' }));

    assert.equal(checked.ok, false);
    assert.match(checked.reason, /lost its tail/);
  });

  test('an output block for a different command is refused', () => {
    const checked = validateReceipt(genuine({ command: 'pnpm lint:check' }));

    assert.equal(checked.ok, false);
    assert.match(checked.reason, /does not open with the command/);
  });
});

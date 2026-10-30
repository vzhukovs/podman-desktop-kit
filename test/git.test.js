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


// Tests for lib/git.js.
//
// git is driven through an injected runner, so what is asserted is the
// contract each form keeps for the wrapper it replaces: what a refusal turns
// into, and which whitespace survives. A sha compared with a trailing newline
// on it, or a diff that lost its leading space, is wrong without looking wrong.

import { EventEmitter } from 'node:events';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { attempt, result, succeeds, text, trimmedEndOrNull, trimmedOrNull, trimmedResult, withStdin } from '../lib/git.js';

/** A runner that succeeds with these streams, recording what it was asked. */
function answering(stdout, stderr = '') {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout, stderr };
  };
  return { exec, calls };
}

/** A runner that refuses the way promisify(execFile) does. */
function refusing({ stdout = '', stderr = '', message = 'Command failed: git', code = 128 } = {}) {
  const error = Object.assign(new Error(message), { stdout, stderr, code });
  return { exec: async () => Promise.reject(error), error };
}

const missing = () => refusing({ message: 'spawn git ENOENT', code: 'ENOENT' });

const CWD = '/repo';

describe('how git is started', () => {
  test('git, with the args, cwd and utf8 — through the injected runner', async () => {
    const { exec, calls } = answering('x');
    await text(['rev-parse', 'HEAD'], { cwd: CWD, exec });

    assert.deepEqual(calls, [{ file: 'git', args: ['rev-parse', 'HEAD'], options: { cwd: CWD, encoding: 'utf8' } }]);
  });

  test('a maxBuffer reaches the runner', async () => {
    const { exec, calls } = answering('x');
    await text(['diff'], { cwd: CWD, exec, maxBuffer: 64 * 1024 * 1024 });

    assert.equal(calls[0].options.maxBuffer, 64 * 1024 * 1024);
    assert.equal(calls[0].options.cwd, CWD);
  });

  // Not undefined, absent: execFile spreads options over its defaults, so an
  // explicit `maxBuffer: undefined` is no cap at all rather than its 1 MB.
  test('no maxBuffer leaves the key out, so execFile keeps its default', async () => {
    const { exec, calls } = answering('x');
    await text(['status'], { cwd: CWD, exec });

    assert.equal(Object.hasOwn(calls[0].options, 'maxBuffer'), false);
  });

  test('every form passes cwd and maxBuffer through', async () => {
    for (const form of [trimmedOrNull, trimmedEndOrNull, result, trimmedResult, succeeds, attempt, text]) {
      const { exec, calls } = answering('x');
      await form(['log'], { cwd: '/elsewhere', exec, maxBuffer: 16 * 1024 * 1024 });
      assert.deepEqual(calls[0].options, { cwd: '/elsewhere', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, form.name);
    }
  });

  test('without an injected runner, the real git runs', async () => {
    assert.match(await text(['--version'], { cwd: process.cwd() }), /^git version /);
  });
});

describe('trimmedOrNull (repo.git)', () => {
  test('success: stdout trimmed at both ends', async () => {
    assert.equal(await trimmedOrNull(['x'], { cwd: CWD, ...answering('  abc123\n') }), 'abc123');
  });

  test('empty output is an empty string, not null', async () => {
    assert.equal(await trimmedOrNull(['x'], { cwd: CWD, ...answering('') }), '');
  });

  test('whitespace only trims to empty', async () => {
    assert.equal(await trimmedOrNull(['x'], { cwd: CWD, ...answering(' \n\t\n') }), '');
  });

  test('a refusal is null', async () => {
    assert.equal(await trimmedOrNull(['x'], { cwd: CWD, ...refusing({ stderr: 'fatal: not a git repository' }) }), null);
  });

  test('a missing git is null too, not an error', async () => {
    assert.equal(await trimmedOrNull(['x'], { cwd: CWD, ...missing() }), null);
  });
});

describe('trimmedEndOrNull (pr.gitOut)', () => {
  test('success: trailing whitespace goes, leading stays', async () => {
    assert.equal(await trimmedEndOrNull(['x'], { cwd: CWD, ...answering(' M lib/a.js\n M lib/b.js\n\n') }), ' M lib/a.js\n M lib/b.js');
  });

  test('empty output is an empty string', async () => {
    assert.equal(await trimmedEndOrNull(['x'], { cwd: CWD, ...answering('') }), '');
  });

  test('a refusal is null', async () => {
    assert.equal(await trimmedEndOrNull(['x'], { cwd: CWD, ...refusing() }), null);
  });

  test('a missing git is null', async () => {
    assert.equal(await trimmedEndOrNull(['x'], { cwd: CWD, ...missing() }), null);
  });
});

describe('result (checkpoint.git)', () => {
  test('success: both streams untouched', async () => {
    assert.deepEqual(await result(['x'], { cwd: CWD, ...answering('  out\n', ' warn\n') }), {
      ok: true,
      stdout: '  out\n',
      stderr: ' warn\n',
    });
  });

  test('empty output', async () => {
    assert.deepEqual(await result(['x'], { cwd: CWD, ...answering('') }), { ok: true, stdout: '', stderr: '' });
  });

  test('a refusal keeps both streams untouched', async () => {
    assert.deepEqual(await result(['x'], { cwd: CWD, ...refusing({ stdout: 'partial\n', stderr: 'fatal: no\n' }) }), {
      ok: false,
      stdout: 'partial\n',
      stderr: 'fatal: no\n',
    });
  });

  test('a refusal with no streams at all falls back to the message', async () => {
    const error = new Error('spawn git EACCES');
    const outcome = await result(['x'], { cwd: CWD, exec: async () => Promise.reject(error) });
    assert.deepEqual(outcome, { ok: false, stdout: '', stderr: 'spawn git EACCES' });
  });

  // promisify(execFile) attaches empty streams to a spawn failure, and `??`
  // keeps an empty string: this is what checkpoint.js reported, so it is kept.
  test('a missing git, as execFile reports it, has an empty stderr', async () => {
    assert.deepEqual(await result(['x'], { cwd: CWD, ...missing() }), { ok: false, stdout: '', stderr: '' });
  });
});

describe('trimmedResult (worktree.git)', () => {
  test('success: both streams trimmed', async () => {
    assert.deepEqual(await trimmedResult(['x'], { cwd: CWD, ...answering('  out\n', '\twarn \n') }), {
      ok: true,
      stdout: 'out',
      stderr: 'warn',
    });
  });

  test('empty output', async () => {
    assert.deepEqual(await trimmedResult(['x'], { cwd: CWD, ...answering('\n') }), { ok: true, stdout: '', stderr: '' });
  });

  test('a refusal: both streams trimmed', async () => {
    const outcome = await trimmedResult(['x'], { cwd: CWD, ...refusing({ stdout: ' partial\n', stderr: 'fatal: dirty\n' }) });
    assert.deepEqual(outcome, { ok: false, stdout: 'partial', stderr: 'fatal: dirty' });
  });

  // The shape test/worktree.test.js injects: a bare error with only stderr.
  test('a refusal with only stderr set', async () => {
    const error = Object.assign(new Error('git exited 128'), { stderr: 'fatal: working tree is dirty ' });
    const outcome = await trimmedResult(['x'], { cwd: CWD, exec: async () => Promise.reject(error) });
    assert.deepEqual(outcome, { ok: false, stdout: '', stderr: 'fatal: working tree is dirty' });
  });

  test('a refusal with no streams falls back to the message', async () => {
    const outcome = await trimmedResult(['x'], { cwd: CWD, exec: async () => Promise.reject(new Error(' boom ')) });
    assert.deepEqual(outcome, { ok: false, stdout: '', stderr: 'boom' });
  });
});

describe('succeeds (slice.gitOk)', () => {
  test('success is true, whatever the output', async () => {
    assert.equal(await succeeds(['x'], { cwd: CWD, ...answering('  anything\n') }), true);
  });

  test('empty output is still success', async () => {
    assert.equal(await succeeds(['x'], { cwd: CWD, ...answering('') }), true);
  });

  test('a refusal is false', async () => {
    assert.equal(await succeeds(['x'], { cwd: CWD, ...refusing({ stderr: 'fatal: bad ref' }) }), false);
  });

  test('a missing git is false', async () => {
    assert.equal(await succeeds(['x'], { cwd: CWD, ...missing() }), false);
  });
});

describe('attempt (slice.gitTry)', () => {
  test('success: stdout then stderr, trimmed as one', async () => {
    assert.deepEqual(await attempt(['x'], { cwd: CWD, ...answering('  [main abc] msg\n', ' 1 file changed\n') }), {
      ok: true,
      output: '[main abc] msg\n 1 file changed',
    });
  });

  test('empty output', async () => {
    assert.deepEqual(await attempt(['x'], { cwd: CWD, ...answering('', '') }), { ok: true, output: '' });
  });

  test('a refusal: what git said, both streams', async () => {
    const outcome = await attempt(['x'], { cwd: CWD, ...refusing({ stdout: 'nothing added\n', stderr: 'hook refused\n' }) });
    assert.deepEqual(outcome, { ok: false, output: 'nothing added\nhook refused' });
  });

  test('a refusal that said nothing falls back to the message', async () => {
    assert.deepEqual(await attempt(['x'], { cwd: CWD, ...refusing({ stdout: ' \n', message: 'Command failed: git commit' }) }), {
      ok: false,
      output: 'Command failed: git commit',
    });
  });

  test('a missing git is a refusal with the spawn message, not a throw', async () => {
    assert.deepEqual(await attempt(['x'], { cwd: CWD, ...missing() }), { ok: false, output: 'spawn git ENOENT' });
  });
});

describe('text (slice.gitText)', () => {
  test('success: stdout exactly as written', async () => {
    assert.equal(await text(['x'], { cwd: CWD, ...answering(' a\n b\n\n') }), ' a\n b\n\n');
  });

  test('empty output is an empty string', async () => {
    assert.equal(await text(['x'], { cwd: CWD, ...answering('') }), '');
  });

  test('stderr is not part of the answer', async () => {
    assert.equal(await text(['x'], { cwd: CWD, ...answering('abc\n', 'warning: x\n') }), 'abc\n');
  });

  test('a refusal rethrows execFile’s own error, untouched', async () => {
    const { exec, error } = refusing({ stderr: 'fatal: bad revision' });
    await assert.rejects(text(['x'], { cwd: CWD, exec }), (thrown) => thrown === error);
  });

  test('a missing git says how to fix it, and is still ENOENT', async () => {
    const { exec, error } = missing();
    await assert.rejects(text(['x'], { cwd: CWD, exec }), (thrown) => {
      assert.match(thrown.message, /^git is not installed — see the required dependencies in README\.md$/);
      assert.equal(thrown.code, 'ENOENT');
      assert.equal(thrown.cause, error);
      return true;
    });
  });
});

/**
 * A spawn that plays one child: writes `stderr`, then exits with `code` or
 * fails to start with `error`. Records what it was asked and what it was fed.
 */
function child({ stderr = '', code = 0, error } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.end = (input) => {
      calls.push({ file, args, options, input });
      setImmediate(() => {
        if (error) {
          proc.emit('error', error);
          proc.emit('close', -2);
          return;
        }
        if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
        proc.emit('close', code);
      });
    };
    return proc;
  };
  return { spawn, calls };
}

describe('withStdin (slice.apply)', () => {
  test('git, with the args and cwd, fed the input', async () => {
    const { spawn, calls } = child();
    await withStdin(['apply', '-'], 'patch\n', { cwd: CWD, spawn });

    assert.deepEqual(calls, [{ file: 'git', args: ['apply', '-'], options: { cwd: CWD }, input: 'patch\n' }]);
  });

  test('exit 0 is ok, stderr as written', async () => {
    assert.deepEqual(await withStdin(['x'], '', { cwd: CWD, ...child({ stderr: 'warning: x\n' }) }), {
      ok: true,
      code: 0,
      stderr: 'warning: x\n',
    });
  });

  test('a non-zero exit is a refusal with its code and stderr', async () => {
    assert.deepEqual(await withStdin(['x'], '', { cwd: CWD, ...child({ stderr: 'error: patch failed\n', code: 1 }) }), {
      ok: false,
      code: 1,
      stderr: 'error: patch failed\n',
    });
  });

  test('git that could not be started is the spawn error, not the close after it', async () => {
    const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    assert.deepEqual(await withStdin(['x'], '', { cwd: CWD, ...child({ error }) }), {
      ok: false,
      code: null,
      stderr: '',
      error: 'spawn git ENOENT',
    });
  });
});

// SPDX-License-Identifier: Apache-2.0

// Tests for lib/reveal.js.
//
// Two of the three platforms cannot be exercised from the third, which is the
// whole reason the choice of command is a pure function taking the platform as
// an argument. What is asserted here is that choice — the part that is wrong on
// a machine nobody testing it owns — plus the promise that failing to open a
// window is never an error.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reveal, revealCommand } from '../lib/reveal.js';

const REPORT = '/home/someone/.pdkit/podman-desktop/reviews/18556.md';

describe('which command shows a file', () => {
  test('macOS reveals the file itself', () => {
    assert.deepEqual(revealCommand(REPORT, 'darwin'), {
      command: 'open',
      args: ['-R', REPORT],
      selects: true,
    });
  });

  // The comma binds the path to the flag. `['/select', path]` is a different
  // command that opens Documents, which is the kind of wrong that looks right.
  test('Windows keeps /select and the path in one argument', () => {
    const chosen = revealCommand('C:\\Users\\someone\\reviews\\18556.md', 'win32');

    assert.equal(chosen.command, 'explorer.exe');
    assert.deepEqual(chosen.args, ['/select,C:\\Users\\someone\\reviews\\18556.md']);
    assert.equal(chosen.args.length, 1, 'split in two it opens the wrong folder');
  });

  // No portable way to select a file: every desktop spells it differently and
  // guessing which is installed is worse than opening the directory.
  test('Linux opens the directory, and says it did not select', () => {
    const chosen = revealCommand(REPORT, 'linux');

    assert.equal(chosen.command, 'xdg-open');
    assert.deepEqual(chosen.args, ['/home/someone/.pdkit/podman-desktop/reviews']);
    assert.equal(chosen.selects, false);
  });

  test('a platform with no convention is null rather than a guess', () => {
    assert.equal(revealCommand(REPORT, 'freebsd'), null);
    assert.equal(revealCommand(REPORT, 'aix'), null);
  });
});

describe('opening, and declining to', () => {
  /** A spawn that records the call and reports a successful start. */
  function fakeSpawn(calls) {
    return (command, args, options) => {
      calls.push({ command, args, options });
      return {
        unref: () => {},
        once: (event, handler) => {
          if (event === 'spawn') queueMicrotask(handler);
        },
      };
    };
  }

  test('the file manager is started detached, so pdkit does not wait on a window', async () => {
    const calls = [];
    const result = await reveal(REPORT, { os: 'darwin', env: {}, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, true);
    assert.deepEqual(calls[0].args, ['-R', REPORT]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
  });

  test('headless Linux is skipped with the reason, not attempted', async () => {
    const calls = [];
    const result = await reveal(REPORT, { os: 'linux', env: {}, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, false);
    assert.match(result.reason, /DISPLAY/);
    assert.equal(calls.length, 0, 'xdg-open with no display blocks or fails; do not call it');
  });

  test('a Linux desktop is attempted', async () => {
    const calls = [];
    assert.equal((await reveal(REPORT, { os: 'linux', env: { DISPLAY: ':0' }, spawn: fakeSpawn(calls) })).opened, true);
    assert.equal((await reveal(REPORT, { os: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, spawn: fakeSpawn(calls) })).opened, true);
    assert.equal(calls.length, 2);
  });

  // The artefact is written and its path printed before any of this. A missing
  // file manager must not turn a finished review into a failure.
  test('a command that is not installed is reported, never thrown', async () => {
    const failing = () => ({
      unref: () => {},
      once: (event, handler) => {
        if (event === 'error') queueMicrotask(() => handler(new Error('spawn xdg-open ENOENT')));
      },
    });

    const result = await reveal(REPORT, { os: 'linux', env: { DISPLAY: ':0' }, spawn: failing });

    assert.equal(result.opened, false);
    assert.match(result.reason, /ENOENT/);
  });

  test('a spawn that throws outright is caught', async () => {
    const throwing = () => {
      throw new Error('EACCES');
    };

    const result = await reveal(REPORT, { os: 'darwin', env: {}, spawn: throwing });

    assert.equal(result.opened, false);
    assert.match(result.reason, /EACCES/);
  });
});

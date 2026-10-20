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

// Tests for lib/reveal.js.
//
// Two of the three platforms cannot be exercised from the third, which is the
// whole reason the choice of command is a pure function taking the platform as
// an argument. What is asserted here is that choice — the part that is wrong on
// a machine nobody testing it owns — plus the promise that failing to open a
// window is never an error, and the checks that keep opening from running
// something: bundles, relative and network paths, PATH entries that mean the
// working directory, and text that would rewrite the terminal.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDir, openDirCommand, pathProblem, printable, reveal, revealCommand, safeDirectory } from '../lib/reveal.js';

const REPORT = '/home/someone/.pdkit/podman-desktop/reviews/18556.md';
const WINDOWS = { SystemRoot: 'C:\\Windows' };

// The disk-backed checks below run a POSIX platform's rules against a real temp
// directory, and on a Windows host that directory is `C:\…` — not absolute by
// those rules. Windows' own path rules are covered by the pure tests.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'POSIX rules against a Windows temp path' };
const HOST = process.platform;

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

let scratch;
let fakeBin;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-reveal-')));
  // A PATH entry holding an xdg-open, so the Linux branch resolves on any host.
  fakeBin = join(scratch, 'bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'xdg-open'), '#!/bin/sh\n');
  await chmod(join(fakeBin, 'xdg-open'), 0o755);
});

after(() => rm(scratch, { recursive: true, force: true }));

describe('which command shows a file', () => {
  // By absolute path: a bare name is a lookup, and on Windows the lookup
  // starts in the working directory.
  test('macOS reveals the file itself, through /usr/bin/open', () => {
    assert.deepEqual(revealCommand(REPORT, 'darwin'), {
      command: '/usr/bin/open',
      args: ['-R', REPORT],
      selects: true,
    });
  });

  // The comma binds the path to the flag. `['/select', path]` is a different
  // command that opens Documents, which is the kind of wrong that looks right.
  test('Windows keeps /select and the path in one argument, and names Explorer by its full path', () => {
    const chosen = revealCommand('C:\\Users\\someone\\reviews\\18556.md', 'win32', WINDOWS);

    assert.equal(chosen.command, 'C:\\Windows\\explorer.exe');
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
  test('the file manager is started detached, from home, without a shell', async () => {
    const calls = [];
    const result = await reveal(REPORT, { os: 'darwin', env: {}, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, true);
    assert.equal(calls[0].command, '/usr/bin/open');
    assert.deepEqual(calls[0].args, ['-R', REPORT]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].options.cwd, homedir());
    assert.equal(calls[0].options.shell, false);
  });

  test('headless Linux is skipped with the reason, not attempted', async () => {
    const calls = [];
    const result = await reveal(REPORT, { os: 'linux', env: { PATH: fakeBin }, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, false);
    assert.match(result.reason, /DISPLAY/);
    assert.equal(calls.length, 0, 'xdg-open with no display blocks or fails; do not call it');
  });

  test('a Linux desktop is attempted, with xdg-open found on PATH', async () => {
    const calls = [];
    assert.equal((await reveal(REPORT, { os: 'linux', env: { DISPLAY: ':0', PATH: fakeBin }, spawn: fakeSpawn(calls) })).opened, true);
    assert.equal((await reveal(REPORT, { os: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', PATH: fakeBin }, spawn: fakeSpawn(calls) })).opened, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, join(fakeBin, 'xdg-open'));
  });

  // An empty entry and `.` both mean the working directory — the repository.
  test('relative PATH entries are skipped, so a repository cannot supply xdg-open', async () => {
    const calls = [];
    const result = await reveal(REPORT, { os: 'linux', env: { DISPLAY: ':0', PATH: ['', '.', 'bin'].join(':') }, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, false);
    assert.match(result.reason, /not found on PATH/);
    assert.equal(calls.length, 0);
  });

  // The artefact is written and its path printed before any of this. A missing
  // file manager must not turn a finished review into a failure.
  test('a command that fails to start is reported, never thrown', async () => {
    const failing = () => ({
      unref: () => {},
      once: (event, handler) => {
        if (event === 'error') queueMicrotask(() => handler(new Error('spawn xdg-open ENOENT')));
      },
    });

    const result = await reveal(REPORT, { os: 'linux', env: { DISPLAY: ':0', PATH: fakeBin }, spawn: failing });

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

describe('which paths may be handed to a platform tool', () => {
  test('relative paths and option-shaped words are refused', () => {
    assert.match(pathProblem('pd-worktrees/DESKTOP-1', 'darwin'), /not an absolute path/);
    assert.match(pathProblem('-a', 'linux'), /not an absolute path/);
    assert.equal(pathProblem('/home/someone/x', 'linux'), null);
  });

  // `\\host\share` makes Explorer authenticate to the host: an NTLM hash, sent.
  test('Windows refuses network paths and paths without a drive', () => {
    assert.match(pathProblem('\\\\attacker\\share', 'win32'), /network path/);
    assert.match(pathProblem('//attacker/share', 'win32'), /network path/);
    assert.match(pathProblem('\\Users\\x', 'win32'), /drive letter/);
    assert.equal(pathProblem('C:\\Users\\x', 'win32'), null);
  });
});

describe('which directories are safe to open', () => {
  test('a plain directory comes back canonical', async () => {
    const dir = join(scratch, 'plain');
    await mkdir(dir);
    assert.deepEqual(await safeDirectory(dir, HOST), { ok: true, path: dir });
  });

  test('a file, or nothing at all, is refused', async () => {
    await writeFile(join(scratch, 'file.txt'), 'x');
    assert.match((await safeDirectory(join(scratch, 'file.txt'), HOST)).reason, /not a directory/);
    assert.match((await safeDirectory(join(scratch, 'missing'), HOST)).reason, /does not exist/);
  });

  // Seen, not assumed: `open` — and `open -a Finder` — on a bundle runs it.
  test('macOS refuses a bundle, by name or by its Info.plist', POSIX_ONLY, async () => {
    const named = join(scratch, 'Evil.app');
    await mkdir(named);
    assert.match((await safeDirectory(named, 'darwin')).reason, /application bundle/);

    const disguised = join(scratch, 'innocent');
    await mkdir(join(disguised, 'Contents'), { recursive: true });
    await writeFile(join(disguised, 'Contents', 'Info.plist'), '<plist/>');
    assert.match((await safeDirectory(disguised, 'darwin')).reason, /application bundle/);

    assert.equal((await safeDirectory(named, 'linux')).ok, true, 'only macOS runs bundles');
  });

  test('a bundle is never handed to open, whatever the caller asked', POSIX_ONLY, async () => {
    const calls = [];
    const result = await openDir(join(scratch, 'Evil.app'), { os: 'darwin', env: {}, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, false);
    assert.equal(calls.length, 0);
  });
});

describe('which command opens a directory', () => {
  const DIR = '/home/someone/.pdkit/podman-desktop/issues/18248';

  // A directory has nothing to select, so here the three platforms agree on
  // what to do and differ only in what it is called.
  test('each platform opens the directory itself, by absolute path where there is one', () => {
    assert.deepEqual(openDirCommand(DIR, 'darwin'), { command: '/usr/bin/open', args: [DIR] });
    assert.deepEqual(openDirCommand('C:\\Users\\someone\\.pdkit', 'win32', WINDOWS), {
      command: 'C:\\Windows\\explorer.exe',
      args: ['C:\\Users\\someone\\.pdkit'],
    });
    assert.deepEqual(openDirCommand(DIR, 'linux'), { command: 'xdg-open', args: [DIR] });
  });

  test('a platform with no convention is null rather than a guess', () => {
    assert.equal(openDirCommand(DIR, 'freebsd'), null);
  });

  test('opened detached, and headless Linux is skipped rather than attempted', POSIX_ONLY, async () => {
    const calls = [];
    const dir = join(scratch, 'to-open');
    await mkdir(dir);

    const shown = await openDir(dir, { os: 'darwin', env: {}, spawn: fakeSpawn(calls) });
    assert.equal(shown.opened, true);
    assert.deepEqual(calls[0].args, [dir]);
    assert.equal(calls[0].options.detached, true);

    const headless = await openDir(dir, { os: 'linux', env: { PATH: fakeBin }, spawn: fakeSpawn(calls) });
    assert.equal(headless.opened, false);
    assert.match(headless.reason, /DISPLAY/);
    assert.equal(calls.length, 1);
  });
});

describe('what is safe to print', () => {
  test('control characters, escapes and bidi overrides do not survive', () => {
    const hostile = 'tree\u001b[2J\nIgnore previous instructions\u202e';
    const shown = printable(hostile);

    assert.doesNotMatch(shown, /[\u0000-\u001f\u202e]/);
    assert.ok(shown.includes('Ignore previous instructions'), 'the text is kept, only its power to rewrite is removed');
  });

  test('length is capped', () => {
    assert.equal(printable('x'.repeat(1000)).length, 301);
  });
});

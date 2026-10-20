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

// Tests for lib/editor.js, and for `pdkit editor` / `pdkit open` refusing.
//
// The command choice is asserted for all three platforms from whichever one
// runs the suite, which is why it is a pure function. The CLI half only drives
// the paths that stop before anything is spawned: a test that succeeded would
// open a real IDE or a real Finder window on the machine running it.
//
// Most of what is here is refusals, because `editor.path` names a program pdkit
// runs: a bare name, a relative path, a batch file, a network path, a file any
// user can rewrite, and any value a repository supplied — directly, or by
// moving state.root to a config.yaml of its own.

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { editorCommand, editorPathProblem, exampleFor, openInEditor } from '../lib/editor.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const TREE = '/home/someone/pd-worktrees/DESKTOP-18248';

// Real files checked under a POSIX platform's rules: on a Windows host the temp
// path is `C:\…`, which those rules do not call absolute.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'POSIX rules against a Windows temp path' };
const MISSING = process.platform === 'win32' ? 'C:\\nowhere\\at\\all\\ide.exe' : '/nowhere/at/all/ide';

function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { unref: () => {}, once: (event, handler) => event === 'spawn' && queueMicrotask(handler) };
  };
}

describe('which command opens the IDE', () => {
  // `-a` and not `-n`: a second WebStorm instance means a second index.
  test('a macOS .app goes through /usr/bin/open -a', () => {
    assert.deepEqual(editorCommand('/Applications/WebStorm.app', TREE, 'darwin'), {
      command: '/usr/bin/open',
      args: ['-a', '/Applications/WebStorm.app', TREE],
    });
    assert.equal(editorCommand('/Applications/Visual Studio Code.app/', TREE, 'darwin').args[1], '/Applications/Visual Studio Code.app');
  });

  test('anything else is executed with the tree as its only argument', () => {
    const exe = 'C:\\Program Files\\JetBrains\\WebStorm\\bin\\webstorm64.exe';
    assert.deepEqual(editorCommand(exe, 'C:\\wt\\DESKTOP-1', 'win32'), { command: exe, args: ['C:\\wt\\DESKTOP-1'] });

    const script = '/home/someone/.local/share/JetBrains/Toolbox/scripts/webstorm';
    assert.deepEqual(editorCommand(script, TREE, 'linux'), { command: script, args: [TREE] });
  });
});

describe('which values editor.path may hold', () => {
  // On Windows a bare name is looked for in the working directory first, and
  // the working directory is a repository.
  test('a bare name or a relative path is refused on every platform', () => {
    for (const os of ['darwin', 'linux', 'win32']) {
      assert.match(editorPathProblem('code', os), /absolute path/, os);
      assert.match(editorPathProblem('./tools/ide', os), /absolute path/, os);
    }
  });

  // cmd.exe re-parses its command line; CVE-2024-27980 is that class.
  test('Windows refuses batch files, and points at the .exe', () => {
    assert.match(editorPathProblem('C:\\VS Code\\bin\\code.cmd', 'win32'), /batch file.*Code\.exe/);
    assert.match(editorPathProblem('C:\\tools\\ide.bat', 'win32'), /batch file/);
    assert.match(editorPathProblem('C:\\tools\\ide.ps1', 'win32'), /not an \.exe/);
    assert.equal(editorPathProblem('C:\\Program Files\\JetBrains\\WebStorm\\bin\\webstorm64.exe', 'win32'), null);
  });

  test('Windows refuses a network path', () => {
    assert.match(editorPathProblem('\\\\attacker\\share\\ide.exe', 'win32'), /network path/);
  });

  test('an absolute POSIX path passes the checks that need no disk', () => {
    assert.equal(editorPathProblem('/Applications/WebStorm.app', 'darwin'), null);
    assert.equal(editorPathProblem('/usr/share/code/code', 'linux'), null);
  });
});

describe('the example a warning prints', () => {
  test('each platform gets a path of its own, under editor:', () => {
    assert.match(exampleFor('darwin'), /editor:\n {4}path: \/Applications\/WebStorm\.app/);
    assert.match(exampleFor('linux'), /Toolbox\/scripts\/webstorm/);
    assert.match(exampleFor('win32'), /webstorm64\.exe/);
  });

  // An example the checks would refuse is a warning that sends the person
  // round in a circle.
  test('every path an example suggests passes the checks', () => {
    for (const os of ['darwin', 'linux', 'win32']) {
      for (const line of exampleFor(os).split('\n').filter((l) => /path:|# or:/.test(l))) {
        const value = line.replace(/^\s*(path:|# or:)\s*/, '').replace(/^'(.*)'$/, '$1').replace(/^~(?=\/)/, '/home/someone');
        assert.equal(editorPathProblem(value, os), null, `${os}: ${value}`);
      }
    }
  });

  // lib/yaml.js reads `\b` inside double quotes as an escape.
  test('Windows paths are single-quoted, so a backslash survives the parse', () => {
    for (const line of exampleFor('win32').split('\n').filter((l) => l.includes('\\'))) {
      assert.match(line, /'[^']*\\[^']*'/);
    }
  });
});

describe('opening, and declining to', () => {
  let scratch;
  let ide;
  let tree;

  before(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-editor-unit-')));
    ide = join(scratch, 'webstorm');
    await writeFile(ide, '#!/bin/sh\n');
    await chmod(ide, 0o755);
    tree = join(scratch, 'DESKTOP-1');
    await mkdir(tree);
  });

  after(() => rm(scratch, { recursive: true, force: true }));

  test('no editor.path is reported as unconfigured, and nothing is spawned', async () => {
    const calls = [];
    const result = await openInEditor(TREE, { editorPath: '', os: 'darwin', env: {}, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, false);
    assert.equal(result.unconfigured, true);
    assert.equal(calls.length, 0);
  });

  test('a path that is not on disk is named, not attempted', async () => {
    const calls = [];
    const result = await openInEditor(TREE, { editorPath: MISSING, env: {}, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, false);
    assert.equal(result.unconfigured, undefined);
    assert.match(result.reason, /which does not exist/);
    assert.equal(calls.length, 0);
  });

  test('a bare name is refused before anything is looked up', async () => {
    const calls = [];
    const result = await openInEditor(tree, { editorPath: 'code', os: 'linux', env: { DISPLAY: ':0' }, spawn: fakeSpawn(calls) });

    assert.match(result.reason, /absolute path/);
    assert.equal(calls.length, 0);
  });

  test('a real launcher is started detached, from home, without a shell, on the canonical tree', POSIX_ONLY, async () => {
    const calls = [];
    const result = await openInEditor(tree, { editorPath: ide, os: 'linux', env: { DISPLAY: ':0' }, spawn: fakeSpawn(calls) });

    assert.equal(result.opened, true);
    assert.equal(calls[0].command, ide);
    assert.deepEqual(calls[0].args, [tree]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.cwd, homedir());
    assert.equal(calls[0].options.shell, false);
  });

  // Anyone on the machine could then choose what pdkit runs.
  test('a program every user can write is refused', POSIX_ONLY, async () => {
    const open = join(scratch, 'shared-ide');
    await writeFile(open, '#!/bin/sh\n');
    await chmod(open, 0o777);

    const calls = [];
    const result = await openInEditor(tree, { editorPath: open, os: 'linux', env: { DISPLAY: ':0' }, spawn: fakeSpawn(calls) });

    assert.match(result.reason, /writable by every user/);
    assert.equal(calls.length, 0);
  });

  test('on macOS a .app must be a bundle, and a bundle is never the tree', POSIX_ONLY, async () => {
    const fake = join(scratch, 'Fake.app');
    await writeFile(fake, 'not a bundle');
    const calls = [];
    assert.match((await openInEditor(tree, { editorPath: fake, os: 'darwin', env: {}, spawn: fakeSpawn(calls) })).reason, /not an application bundle/);

    const bundleTree = join(scratch, 'Evil.app');
    await mkdir(bundleTree);
    assert.match((await openInEditor(bundleTree, { editorPath: ide, os: 'darwin', env: {}, spawn: fakeSpawn(calls) })).reason, /application bundle/);
    assert.equal(calls.length, 0);
  });

  test('headless Linux is skipped with the reason', POSIX_ONLY, async () => {
    const calls = [];
    const result = await openInEditor(tree, { editorPath: ide, os: 'linux', env: {}, spawn: fakeSpawn(calls) });

    assert.match(result.reason, /DISPLAY/);
    assert.equal(calls.length, 0);
  });

  test('a spawn error comes back as the reason', POSIX_ONLY, async () => {
    const failing = () => ({ unref: () => {}, once: (event, handler) => event === 'error' && queueMicrotask(() => handler(new Error('spawn ENOENT'))) });
    const result = await openInEditor(tree, { editorPath: ide, os: 'linux', env: { DISPLAY: ':0' }, spawn: failing });

    assert.equal(result.opened, false);
    assert.match(result.reason, /ENOENT/);
  });
});

describe('pdkit editor and pdkit open, refusing', () => {
  let repo;
  let home;

  before(async () => {
    repo = await initRepo('pdkit-editor-');
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-editor-home-')));
    await writeFiles(repo, { 'README.md': 'fixture\n' });
    await commitAll(repo, 'init');
    await git(['checkout', '-b', 'DESKTOP-4242/open-things'], repo);
  });

  after(() => cleanup(repo, home));

  async function pdkit(args, env = { ...process.env, PDKIT_HOME: home }) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  }

  // The one failure with a fix that fits on a screen, so the fix is printed.
  test('no editor.path is exit 1, with the file to edit and the lines to add', async () => {
    const result = await pdkit(['editor']);

    assert.equal(result.code, 1);
    assert.equal(result.stdout.trim(), repo, 'the issue comes from the branch, and the path is printed anyway');
    assert.match(result.stderr, /editor\.path is not configured/);
    assert.ok(result.stderr.includes(join(home, 'config.yaml')));
    assert.match(result.stderr, /editor:\n {4}path: /);
  });

  test('--json carries the example instead of a warning', async () => {
    const result = await pdkit(['editor', '--json']);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.code, 1);
    assert.equal(parsed.unconfigured, true);
    assert.match(parsed.example, /editor:/);
  });

  test('a configured path that is not there is exit 1, and named', async () => {
    await writeFile(join(home, 'config.yaml'), `editor:\n  path: '${MISSING}'\n`);
    try {
      const result = await pdkit(['editor']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /which does not exist/);
    } finally {
      await writeFile(join(home, 'config.yaml'), '');
    }
  });

  // A pull request's tree decides what .pdkit.yaml says.
  test('editor.path from a repository is refused, not run', async () => {
    await writeFile(join(repo, '.pdkit.yaml'), 'editor:\n  path: /bin/sh\n');
    try {
      const result = await pdkit(['editor']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /a repository does not choose what pdkit runs/);
    } finally {
      await rm(join(repo, '.pdkit.yaml'));
    }
  });

  // Moving state.root moves the config.yaml editor.path is read from, and on
  // macOS chooses what `open` runs. Without PDKIT_HOME, so the layer is read.
  test('a repository that moves state.root is refused by both commands', async () => {
    await writeFile(join(repo, '.pdkit.yaml'), 'state:\n  root: ./Evil.app\n');
    const env = { ...process.env };
    delete env.PDKIT_HOME;
    try {
      for (const args of [['open', 'home'], ['open', 'issue'], ['editor']]) {
        const result = await pdkit(args, env);
        assert.equal(result.code, 1, args.join(' '));
        assert.match(result.stderr, /state\.root is set by .*\.pdkit\.yaml/, args.join(' '));
      }
    } finally {
      await rm(join(repo, '.pdkit.yaml'));
    }
  });

  test('an issue with no tree says how to make one', async () => {
    const result = await pdkit(['editor', '999']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /pdkit worktree create --issue 999/);
  });

  test('open issue reads the issue from the branch, and refuses one never triaged', async () => {
    const result = await pdkit(['open', 'issue']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /issue 4242 has no state/);
  });

  test('open with no target, or the wrong one, names the three', async () => {
    for (const args of [['open'], ['open', 'desk']]) {
      const result = await pdkit(args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /home \| issue \[<issue>\] \| tree \[<issue>\]/);
    }
  });

  // parseInt reads `12abc` as 12 — somebody else's issue.
  test('anything but digits is refused rather than read as a number', async () => {
    for (const given of ['abc', '12abc', '1e3', '0x10']) {
      const result = await pdkit(['open', 'tree', given]);
      assert.equal(result.code, 1, given);
      assert.match(result.stderr, /not an issue number/, given);
    }
  });
});

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

// Tests for lib/hooks/prompt-submit.js.
//
// The case it exists for is DESKTOP-18915's: a tree on issue A's branch, a
// command typed for issue B, and B's work in a worktree beside it. What is
// asserted is that the context then names both trees and tells Claude to move
// the session with EnterWorktree — and that every other prompt gets nothing at
// all, because the hook runs on every message and a line on each would be read
// as noise.
//
// The main checkout is never an issue's tree, even on that issue's branch: a
// command typed there is told how to move the branch out and where to go.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PLUGIN_ROOT, issueDir } from '../lib/config.js';
import { FAIL_CLOSED, HOOK_HANDLERS } from '../lib/hooks/events.js';
import { argumentKind, handle, parseCommand } from '../lib/hooks/prompt-submit.js';
import { transition } from '../lib/state.js';

const execFileAsync = promisify(execFile);
const git = (args, cwd) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

const HERE = 18967;
const AWAY = 18915;
const PARKED = 18833;

let home;
let base;
let MAIN;
let AWAY_TREE;
const savedHome = process.env.PDKIT_HOME;

const submit = (prompt, cwd = MAIN) => handle({ prompt, cwd }, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT });

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-prompt-'));
  base = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-prompt-repo-')));
  process.env.PDKIT_HOME = home;

  // The main checkout left on one issue's branch, a registered worktree for
  // another, and a third issue whose branch is checked out nowhere.
  MAIN = join(base, 'podman-desktop');
  AWAY_TREE = join(base, `DESKTOP-${AWAY}`);
  await mkdir(MAIN);
  await git(['init', '-q', '-b', 'main'], MAIN);
  await git(['commit', '-q', '--allow-empty', '-m', 'init'], MAIN);
  await git(['branch', `DESKTOP-${PARKED}/1-store-image-info-ui`], MAIN);
  await git(['switch', '-q', '-c', `DESKTOP-${HERE}/1-fix-main-event-stream-reconnect`], MAIN);
  await git(['worktree', 'add', '-q', '-b', `DESKTOP-${AWAY}/1-quit-and-install-race`, AWAY_TREE, 'main'], MAIN);

  await transition(AWAY, 'triaged', { home });
});

after(async () => {
  if (savedHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = savedHome;

  for (const dir of [home, base]) await rm(dir, { recursive: true, force: true });
});

describe('reading the command', () => {
  test('as typed', () => {
    assert.deepEqual(parseCommand('/pd:preflight 18915'), { skill: 'preflight', number: 18915 });
    assert.deepEqual(parseCommand('  /pd:pr 18915 2\nand the body'), { skill: 'pr', number: 18915 });
    assert.deepEqual(parseCommand('/pd:pr-sync #19750'), { skill: 'pr-sync', number: 19750 });
  });

  test('as the host expands it', () => {
    const expanded = '<command-message>pd:preflight</command-message>\n<command-name>/pd:preflight</command-name>\n<command-args>18915</command-args>';
    assert.deepEqual(parseCommand(expanded), { skill: 'preflight', number: 18915 });
  });

  test('and nothing else', () => {
    for (const prompt of ['почини preflight для 18915', '/pd:pr-status', '/pd:triage --label kind/bug', 'see /pd:preflight 18915', '/clear']) {
      assert.equal(parseCommand(prompt), null, prompt);
    }
  });

  // Read from the skills' argument-hint, so a skill that changes what it takes
  // changes what the hook does without a list here to forget.
  test('an issue or a pull request, by what the skill says it takes', () => {
    assert.equal(argumentKind('<issue-number>'), 'issue');
    assert.equal(argumentKind('<issue-number> [slice]'), 'issue');
    assert.equal(argumentKind('[<issue-number|url>] [--label <a,b>]'), 'issue');
    assert.equal(argumentKind('<pr-number>'), 'pr');
    assert.equal(argumentKind(null), null);
    assert.equal(argumentKind('<anything-else>'), null);
  });
});

describe('a command for one issue, typed in another issue\'s tree', () => {
  test('names both trees and tells the session to move into the issue\'s', async () => {
    const decision = await submit(`/pd:preflight ${AWAY}`);

    assert.equal(decision.block, false);
    assert.match(decision.message, /\/pd:preflight is about issue 18915 — triaged, and this tree is not its/);
    assert.match(
      decision.message,
      new RegExp(`here {4}: ${MAIN} on DESKTOP-${HERE}/1-fix-main-event-stream-reconnect — the main checkout — issue ${HERE}'s`),
    );
    assert.match(decision.message, new RegExp(`${AWAY} {3}: ${AWAY_TREE} on DESKTOP-${AWAY}/1-quit-and-install-race`));
    assert.match(decision.message, new RegExp(`Call the EnterWorktree tool with path: ${AWAY_TREE}$`, 'm'));
    // The tree exists: nothing to run first.
    assert.doesNotMatch(decision.message, /pdkit worktree create|git -C/);
  });

  test('a branch checked out nowhere is named, with how to get a tree for it', async () => {
    const decision = await submit(`/pd:slice ${PARKED}`);

    assert.match(decision.message, new RegExp(`DESKTOP-${PARKED}/1-store-image-info-ui, a local branch checked out nowhere`));
    assert.match(decision.message, new RegExp(`^ +pdkit worktree create --issue ${PARKED} --branch DESKTOP-${PARKED}/1-store-image-info-ui$`, 'm'));
    assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${join(base, 'pd-worktrees', `DESKTOP-${PARKED}`)}$`, 'm'));
    // Only the main checkout's own branch is switched away from, never this one.
    assert.doesNotMatch(decision.message, /git -C/);
    // No record for it: the line says nothing it does not know.
    assert.doesNotMatch(decision.message, new RegExp(`${PARKED} — `));
  });

  // The way /pd:pr-sync arrives: a pull request number, mapped through the
  // record pdkit keeps of what it published.
  test('a pull request of ours is followed to its issue', async () => {
    await writeFile(join(issueDir(home, AWAY), 'prs.json'), JSON.stringify({ prs: [{ number: 19750, slice: 1 }] }));
    try {
      const decision = await submit('/pd:pr-sync 19750');
      assert.match(decision.message, /\/pd:pr-sync is about issue 18915/);
      assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${AWAY_TREE}$`, 'm'));
    } finally {
      await rm(join(issueDir(home, AWAY), 'prs.json'), { force: true });
    }
  });
});

// DESKTOP-18915 once more: the pull request's branch left in the main checkout
// by `slice materialize`, and the review round committed beside the worktree.
describe('the main checkout on the issue\'s own branch', () => {
  test('is not the issue\'s tree: the branch moves out, then the session follows', async () => {
    const decision = await submit(`/pd:audit ${HERE}`);

    assert.match(decision.message, /\/pd:audit is about issue 18967, and this tree is not its/);
    assert.match(decision.message, new RegExp(`DESKTOP-${HERE}/1-fix-main-event-stream-reconnect, held by the main checkout`));
    const steps = decision.message.split('\n').filter((line) => /^ {7}\S/.test(line)).map((line) => line.trim());
    assert.deepEqual(steps, [
      `git -C ${MAIN} switch main`,
      `pdkit worktree create --issue ${HERE} --branch DESKTOP-${HERE}/1-fix-main-event-stream-reconnect`,
    ]);
    assert.match(decision.message, /Show the person these commands and run them once they agree/);
    assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${join(base, 'pd-worktrees', `DESKTOP-${HERE}`)}$`, 'm'));
  });
});

describe('everything else is quiet', () => {
  test('the issue\'s own tree', async () => {
    assert.equal((await submit(`/pd:preflight ${AWAY}`, AWAY_TREE)).message, undefined);
  });

  test('an issue nothing names yet', async () => {
    assert.equal((await submit('/pd:triage 11111')).message, undefined);
  });

  test('somebody else\'s pull request', async () => {
    assert.equal((await submit('/pd:review-pr 19001')).message, undefined);
  });

  test('a skill whose argument is not a number of ours', async () => {
    assert.equal((await submit(`/pd:knowledge ${AWAY}`)).message, undefined);
  });

  test('plain text, and a payload with no prompt', async () => {
    assert.equal((await submit(`what is left on ${AWAY}?`)).message, undefined);
    assert.deepEqual(await handle({ cwd: MAIN }, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT }), { block: false });
    assert.deepEqual(await handle(null, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT }), { block: false });
  });

  // `user_prompt` is the name plugin-dev material uses; reading it too costs nothing.
  test('the other name for the prompt is read the same way', async () => {
    const decision = await handle({ user_prompt: `/pd:preflight ${AWAY}`, cwd: MAIN }, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT });
    assert.match(decision.message, /EnterWorktree/);
  });
});

// The wiring, which a direct call to handle() cannot prove — the lesson of the
// receipt gate that sat on an event subagents never raise.
describe('the hook is registered on the prompt', () => {
  test('UserPromptSubmit runs this module, for every prompt', async () => {
    const { hooks } = JSON.parse(await readFile(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const entries = hooks.UserPromptSubmit ?? [];
    const routed = entries.flatMap((entry) => entry.hooks ?? []).filter((hook) => HOOK_HANDLERS[hook.args?.[1]] === 'prompt-submit.js');

    assert.equal(routed.length, 1);
    for (const entry of entries) assert.ok([undefined, '', '*'].includes(entry.matcher));
  });

  // A block on this event discards what the person typed.
  test('and a handler that cannot run lets the prompt through', () => {
    assert.ok(!FAIL_CLOSED.includes('prompt-submit'));
  });

  test('through the binary, the message reaches stdout and the exit is 0', async () => {
    const run = await new Promise((resolve) => {
      const child = spawn('node', [join(PLUGIN_ROOT, 'bin', 'pdkit'), 'hook', 'prompt-submit'], {
        env: { ...process.env, PDKIT_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('exit', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: `/pd:preflight ${AWAY}`, cwd: MAIN }));
    });

    assert.equal(run.code, 0);
    assert.match(run.stdout, new RegExp(`${AWAY_TREE} on DESKTOP-${AWAY}/1-quit-and-install-race`));
  });
});

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

// Tests for lib/hooks/task-completed.js and lib/hooks/session-start.js.
//
// Both hooks read the same pointer, so they share a fixture. What is asserted
// for the first is that "done" cannot be claimed: the three ways to arrive
// without evidence — no receipt, an edited one, a red one — are each a refusal
// with a different message, because "run this command" and "your tests fail"
// are different problems.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { start, stop } from '../lib/active.js';
import { record as recordAttempt, unblock as unblockTask } from '../lib/attempts.js';
import { issueDir } from '../lib/config.js';
import { writeReceipt } from '../lib/evidence.js';
import { handle as sessionStart } from '../lib/hooks/session-start.js';
import { HOOK_HANDLERS } from '../lib/hooks/events.js';
import { IMPLEMENTER, STALL_LIMIT, handle as taskCompleted } from '../lib/hooks/task-completed.js';
import { read as readJournal } from '../lib/journal.js';
import { TRANSITIONS, setOwns, transition } from '../lib/state.js';

const execFileAsync = promisify(execFile);

const ISSUE = 18248;

let home;
// A real repository, because both hooks resolve the working tree by asking
// git which one a directory belongs to.
let WORKTREE;
const savedHome = process.env.PDKIT_HOME;

/** @param {{exitCode?: number, stdout?: string}} [over] */
const run = (over = {}) => ({
  command: 'pnpm test:main -- container-registry.spec.ts',
  exitCode: 0,
  stdout: 'Test Files  1 passed (1)\n',
  stderr: '',
  durationMs: 4210,
  at: '2026-07-31T10:00:00.000Z',
  complete: true,
  ...over,
});

const receiptPath = () => join(issueDir(home, ISSUE), 'receipts', 'T1.md');

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-taskdone-'));
  WORKTREE = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-taskdone-repo-')));
  process.env.PDKIT_HOME = home;

  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: WORKTREE });

  await transition(ISSUE, 'triaged', { home });
  await setOwns(ISSUE, 'T1', ['packages/main/src/plugin/container-registry.ts'], { home });

  await mkdir(join(issueDir(home, ISSUE), 'tasks'), { recursive: true });
  await writeFile(
    join(issueDir(home, ISSUE), 'tasks', 'T1.md'),
    '# T1: join the command arguments\n\n- Issue: 18248\n- Satisfies: R1\n\n## Owns\npackages/main/src/plugin/container-registry.ts\n',
  );
});

beforeEach(async () => {
  await rm(receiptPath(), { force: true });
  await start({ issue: ISSUE, taskId: 'T1', worktree: WORKTREE, home });
});

after(async () => {
  if (savedHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = savedHome;

  for (const dir of [home, WORKTREE]) await rm(dir, { recursive: true, force: true });
});

// A fresh run id per call: each call stands for a separate run, and the stall
// limit counts stops per run, so one shared id would make every test depend on
// how many came before it.
let runs = 0;
const complete = () =>
  taskCompleted({ task_id: `agent-7-${(runs += 1)}`, cwd: WORKTREE }, { event: 'task-completed', pluginRoot: '' });

// How much machinery an issue took. Dollars alone cannot tell a big issue from
// a wasteful one — an issue with seven tasks and two slices is supposed to cost
// more than a one-task fix — and this hook is the only place that sees every
// subagent finish. Counted here rather than reported by the session, because a
// count an agent writes about itself is one it can forget to write.
//
// The journal is global and append-only, so these assert on the newest entry
// and on deltas rather than on totals: entries from the tests above are part of
// the same file's history, which is the property being relied on everywhere
// else.
// The structural half of the fix, and the half a unit test can actually hold.
// Every test below calls the handler directly, so they pass identically whether
// the host ever runs it or not — which is how a receipt gate wired to
// `TaskCompleted` stayed green for four months while subagents, which raise
// `SubagentStop`, never reached it. What can be pinned here is the wiring
// itself: the manifest names the event subagents raise, and the map sends that
// event to this module. Whether the host keeps its side of it is what
// `pdkit doctor` watches, through `agent-done` in the journal.
describe('the hook is registered where subagents finish', () => {
  const manifest = async () => JSON.parse(await readFile(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8'));
  const eventsRouting = (hooks, hostEvent) =>
    (hooks[hostEvent] ?? []).flatMap((entry) => entry.hooks ?? []).map((hook) => hook.args?.[1]);

  test('SubagentStop runs this module', async () => {
    const { hooks } = await manifest();
    const routed = eventsRouting(hooks, 'SubagentStop').filter((event) => HOOK_HANDLERS[event] === 'task-completed.js');

    assert.equal(routed.length, 1, 'exactly one SubagentStop entry reaches lib/hooks/task-completed.js');
  });

  // No matcher: SubagentStop matches on agent type, and the count is only worth
  // anything if every type is in it.
  test('for every agent type', async () => {
    const { hooks } = await manifest();
    for (const entry of hooks.SubagentStop) {
      assert.ok([undefined, '', '*'].includes(entry.matcher), `SubagentStop is narrowed to "${entry.matcher}"`);
    }
  });

  // TaskCompleted fires on TaskUpdate and on agent-team teammates, neither of
  // which this plugin uses. A handler there would count task-list ticks as
  // subagents, and — the original defect — looks like coverage while being none.
  test('and no other host event does', async () => {
    const { hooks } = await manifest();
    const elsewhere = Object.keys(hooks)
      .filter((hostEvent) => hostEvent !== 'SubagentStop')
      .filter((hostEvent) => eventsRouting(hooks, hostEvent).some((event) => HOOK_HANDLERS[event] === 'task-completed.js'));

    assert.deepEqual(elsewhere, []);
    assert.equal(hooks.TaskCompleted, undefined, 'TaskCompleted is not an event subagents raise');
  });
});

// Only the implementer's finish claims a task. On SubagentStop a refusal keeps
// the agent running, so a scout or an auditor caught by the gate mid-exec would
// be held until it wrote a receipt for work that was never its job.
describe('who the gate is for', () => {
  const finish = (agentType) =>
    taskCompleted({ agent_id: 'agent-21', agent_type: agentType, cwd: WORKTREE }, { event: 'subagent-stop', pluginRoot: '' });

  test('the implementer is held to the receipt', async () => {
    const decision = await finish(IMPLEMENTER);

    assert.equal(decision.block, true);
    assert.match(decision.reason, /there is no receipt/);
  });

  test('any other agent under an active task is let through, and still counted', async () => {
    const before = (await readJournal({ issue: ISSUE, event: 'agent-done' }, { home })).length;

    for (const agentType of ['pd:pd-scout', 'pd:pd-auditor', 'general-purpose']) {
      const decision = await finish(agentType);
      assert.equal(decision.block, false, `${agentType} is not asked for T1's receipt`);
    }

    const runs = await readJournal({ issue: ISSUE, event: 'agent-done' }, { home });
    assert.equal(runs.length, before + 3);
    assert.match(runs.at(-1).detail, /general-purpose; while T1 was active/);
  });

  // A host that stops naming agents must not open the gate.
  test('a finish that does not say who it was is gated', async () => {
    const decision = await taskCompleted({ agent_id: 'agent-22', cwd: WORKTREE }, { event: 'subagent-stop', pluginRoot: '' });
    assert.equal(decision.block, true);
  });

  // The constant and the agent definition are two spellings of one name, and
  // only one of them is what the host reports. Renaming the agent alone would
  // turn the gate off without failing anything else.
  test('the name matches the agent this plugin ships', async () => {
    const definition = await readFile(join(process.cwd(), 'agents', 'pd-implementer.md'), 'utf8');
    const name = /^name:\s*(\S+)\s*$/m.exec(definition)?.[1];
    const plugin = JSON.parse(await readFile(join(process.cwd(), '.claude-plugin', 'plugin.json'), 'utf8')).name;

    assert.equal(IMPLEMENTER, `${plugin}:${name}`);
  });
});

describe('counting the agents that ran', () => {
  const agentRuns = async (issue) => (await readJournal({ issue }, { home })).filter((entry) => entry.event === 'agent-done');

  // Back to where the rest of the file expects to stand. `checkout main` cannot
  // do it: the fixture has no commits, so `main` never became a ref — and
  // repointing HEAD works on an unborn branch, which is the state under test.
  after(async () => {
    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: WORKTREE });
  });

  test('a completion is counted, and carries the agent task id', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    await complete();

    const entry = (await agentRuns(ISSUE)).at(-1);
    assert.ok(entry, 'the run reached the journal');
    assert.match(entry.detail, /agent task agent-7/);
    assert.match(entry.detail, /while T1 was active/);
  });

  // The ordering that makes the count honest. An agent that finishes has run,
  // whatever the handler then decides about its claim — counting only accepted
  // completions would make the record cheapest exactly where the work went
  // worst, which is the opposite of what it is for.
  test('a refused completion is counted too', async () => {
    const before = (await agentRuns(ISSUE)).length;

    const decision = await complete();
    assert.equal(decision.block, true, 'no receipt, so the completion is refused');

    assert.equal((await agentRuns(ISSUE)).length, before + 1);
  });

  // Scouts, the plan critic, the auditor, the slicer: none of them runs under
  // an active task, and all of them used to pass through in silence.
  test('an agent that runs under no task is counted, and the branch says whose it is', async () => {
    await stop({ worktree: WORKTREE, home });
    await execFileAsync('git', ['checkout', '-q', '-b', `DESKTOP-${ISSUE}/scouting`], { cwd: WORKTREE });

    const before = (await agentRuns(ISSUE)).length;
    const decision = await taskCompleted({ task_id: 'agent-9', cwd: WORKTREE }, { event: 'task-completed', pluginRoot: '' });

    assert.equal(decision.block, false, 'no task is active, so there is no claim to check');

    const runs = await agentRuns(ISSUE);
    assert.equal(runs.length, before + 1, 'attributed to the issue its branch names');
    assert.match(runs.at(-1).detail, /agent task agent-9/);
    assert.ok(!/while/.test(runs.at(-1).detail), 'no task was active, and the entry does not invent one');
  });

  // The payload SubagentStop actually sends, as captured from Claude Code
  // 2.1.301: `agent_id` and `agent_type`, no `task_id`. Before this the entry
  // would have read "agent task unnamed" for every run.
  test('the SubagentStop payload names the run and the kind of agent', async () => {
    await stop({ worktree: WORKTREE, home });
    await execFileAsync('git', ['checkout', '-q', '-b', `DESKTOP-${ISSUE}/subagent-stop`], { cwd: WORKTREE });

    await taskCompleted(
      { hook_event_name: 'SubagentStop', agent_id: 'a8b1072c', agent_type: 'pd:pd-scout', stop_hook_active: false, cwd: WORKTREE },
      { event: 'subagent-stop', pluginRoot: '' },
    );

    const entry = (await agentRuns(ISSUE)).at(-1);
    assert.equal(entry.detail, 'agent task a8b1072c; pd:pd-scout');
  });

  // A wrong attribution is worse than none in the one file nothing may rewrite.
  test('an agent nothing can attribute is recorded without an issue', async () => {
    await stop({ worktree: WORKTREE, home });
    await execFileAsync('git', ['checkout', '-q', '-b', 'some-other-branch'], { cwd: WORKTREE });

    await taskCompleted({ task_id: 'agent-11', cwd: WORKTREE }, { event: 'task-completed', pluginRoot: '' });

    const entry = (await readJournal({}, { home })).filter((line) => line.event === 'agent-done' && line.issue === null).at(-1);
    assert.ok(entry, 'recorded, and attributed to nobody');
    assert.match(entry.detail, /agent task agent-11/);
  });
});

describe('completing a task', () => {
  test('a task with no receipt cannot be completed, and the refusal is the command', async () => {
    const decision = await complete();

    assert.equal(decision.block, true);
    assert.match(decision.reason, /there is no receipt/);
    assert.match(decision.reason, /pdkit receipt write --issue 18248 --task T1/);
  });

  test('a task with a genuine passing receipt completes', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });

    const decision = await complete();
    assert.equal(decision.block, false);
    assert.match(decision.message, /T1 has a receipt/);
  });

  test('an edited receipt is refused', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    const content = await readFile(receiptPath(), 'utf8');
    await writeFile(receiptPath(), content.replace('1 passed (1)', '9 passed (9)'));

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.match(decision.reason, /edited after it was captured/);
  });

  // The receipt is valid; the run failed. Those are different problems and the
  // message has to say which, or the fix is guessed at.
  test('a genuine receipt for a failing run refuses the completion, not the receipt', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.match(decision.reason, /valid receipt for a command that failed/);
    assert.match(decision.reason, /report it rather than editing/);
  });

  // Twice, "fix it and capture again" is the right advice. The third time it is
  // the advice that built the loop, and the hook has to say something else.
  test('at the ceiling the refusal stops being about the receipt', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'attempts');
    assert.match(decision.reason, /is blocked: 3 failed captures/);
    assert.match(decision.reason, /pdkit task unblock/);
  });

  // On SubagentStop a refusal keeps the subagent running with the reason as its
  // next instruction. At the ceiling that instruction is "you are blocked", and
  // holding the agent a second time would make it try a fourth time — so the
  // host's second ask (stop_hook_active) is let through, with the same words.
  test('at the ceiling a subagent already told is let go, not held for a fourth try', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }

    const decision = await taskCompleted(
      { agent_id: 'agent-7', stop_hook_active: true, cwd: WORKTREE },
      { event: 'subagent-stop', pluginRoot: '' },
    );
    assert.equal(decision.block, false);
    assert.equal(decision.rule, 'attempts');
    assert.match(decision.message, /is blocked: \d+ failed captures/);
  });

  // Only the ceiling. A missing or red receipt is something the subagent can
  // still fix, so a second ask is refused like the first.
  test('below the ceiling a second ask is refused like the first', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'reset for the test', home });

    const decision = await taskCompleted(
      { agent_id: 'agent-7', stop_hook_active: true, cwd: WORKTREE },
      { event: 'subagent-stop', pluginRoot: '' },
    );
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'receipt');
  });

  test('and an unblock puts the ordinary refusal back', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }
    await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'plan amended: A1', home });

    const decision = await complete();
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'receipt');
    assert.match(decision.reason, /valid receipt for a command that failed/);
  });

  // `pdkit receipt write` can fail before it captures anything: a missing task
  // file, or a `Done when` that is prose. No attempt is recorded, so the
  // ceiling never comes. Without a limit of its own, the hook would hold the
  // agent forever, telling it to run a command that cannot run.
  describe('a run that cannot capture', () => {
    const stopAs = (id) =>
      taskCompleted({ agent_id: id, agent_type: IMPLEMENTER, cwd: WORKTREE }, { event: 'subagent-stop', pluginRoot: '' });

    test(`is warned on stop ${STALL_LIMIT} and let go after, without being accepted`, async () => {
      const accepted = async () => (await readJournal({ issue: ISSUE, event: 'task-receipt' }, { home })).length;
      const acceptedBefore = await accepted();

      for (let stop = 1; stop < STALL_LIMIT; stop += 1) {
        const decision = await stopAs('stuck-1');
        assert.equal(decision.block, true, `stop ${stop} is held`);
        assert.ok(!/next stop is let go/.test(decision.reason), `stop ${stop} carries no warning yet`);
      }

      const warned = await stopAs('stuck-1');
      assert.equal(warned.block, true);
      assert.match(warned.reason, /there is no receipt/);
      assert.match(warned.reason, /next stop is let go/);

      const released = await stopAs('stuck-1');
      assert.equal(released.block, false);
      assert.equal(released.rule, 'stalled');
      assert.match(released.message, /NOT accepted/);
      assert.equal(await accepted(), acceptedBefore, 'letting go is not acceptance');
    });

    // The loop the limit guards against is stops with nothing between them. A
    // run that keeps capturing is making progress, and the attempts ceiling
    // governs it instead.
    test('a capture starts the count again', async () => {
      await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'reset for the test', home });
      await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });

      for (let stop = 0; stop < STALL_LIMIT; stop += 1) await stopAs('capturing-1');
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });

      const decision = await stopAs('capturing-1');
      assert.equal(decision.block, true);
      assert.match(decision.reason, /valid receipt for a command that failed/);
      assert.ok(!/next stop is let go/.test(decision.reason));
    });

    // Per run: one agent's stuck stops do not use up the next one's.
    test('another run starts from nothing', async () => {
      for (let stop = 0; stop <= STALL_LIMIT; stop += 1) await stopAs('stuck-2');

      const decision = await stopAs('fresh-1');
      assert.equal(decision.block, true);
      assert.equal(decision.rule, 'receipt');
    });
  });

  test('acceptance is journalled with the agent’s own task id', async () => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    await complete();

    const entry = (await readJournal({ issue: ISSUE, event: 'task-receipt' }, { home })).at(-1);
    assert.match(entry.detail, /T1 accepted/);
    assert.match(entry.detail, /agent-7/);
  });

  // Outside a tree that is executing a planned task, this hook has no business
  // holding up anything.
  test('with no active task the event passes through', async () => {
    await stop({ worktree: WORKTREE, home });

    const decision = await complete();
    assert.equal(decision.block, false);
  });
});

describe('re-anchoring', () => {
  const startSession = () => sessionStart({ cwd: WORKTREE }, { event: 'session-start', pluginRoot: '' });

  test('the summary names the issue, the task, its files and where it can go next', async () => {
    const decision = await startSession();

    assert.equal(decision.block, false);
    assert.match(decision.message, /issue 18248 — triaged/);
    assert.match(decision.message, /T1 \(join the command arguments\)/);
    assert.match(decision.message, /packages\/main\/src\/plugin\/container-registry\.ts/);
    // Read from the transition table rather than pinned as a string: this line
    // exists to prove the summary offers the moves the machine allows, and a
    // literal copy of them turns every edge added to section 1 into a failing
    // test about nothing. `answered` was the edge that showed it (0.27).
    assert.match(decision.message, new RegExp(`next {4}: ${TRANSITIONS['triaged'].join(', ')}`));
  });

  test('the journal is summarized, not injected whole', async () => {
    const decision = await startSession();

    assert.match(decision.message, /recent/);
    assert.ok(decision.message.split('\n').length < 20, 'the summary should stay small enough to be worth injecting');
  });

  // A fresh session is exactly where a blocked task gets tried a fourth time:
  // the three failures are in the context that just went away.
  test('a blocked task survives the restart that lost the reason it is blocked', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    }

    const decision = await startSession();
    assert.match(decision.message, /tried {3}: 3 of 3 failed capture\(s\) — BLOCKED/);
    assert.match(decision.message, /pdkit task unblock/);
  });

  // An empty session should not open with plugin noise: the first thing a user
  // reads sets what they learn to skip.
  test('no active task on a branch that is not ours means no output at all', async () => {
    await stop({ worktree: WORKTREE, home });

    const decision = await startSession();
    assert.equal(decision.block, false);
    assert.equal(decision.message, undefined);
  });

  // A task pointer only exists inside exec. Every other phase boundary is a
  // tree with no task running, and a session per phase is only cheap if the
  // session that opens there is told where it is.
  describe('between phases, the branch names the issue', () => {
    // HEAD is moved rather than checked out: the fixture has no commits, and an
    // unborn branch is still the answer `git branch --show-current` gives.
    const onBranch = async (name, body) => {
      await execFileAsync('git', ['symbolic-ref', 'HEAD', `refs/heads/${name}`], { cwd: WORKTREE });
      try {
        await body();
      } finally {
        await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: WORKTREE });
      }
    };

    test('and the summary says what to run, with no task in it', async () => {
      await stop({ worktree: WORKTREE, home });

      await onBranch(`DESKTOP-${ISSUE}/join-container-command`, async () => {
        const decision = await startSession();
        assert.equal(decision.block, false);
        assert.match(decision.message, /issue 18248 — triaged/);
        assert.match(decision.message, /task {4}: none running/);
        assert.match(decision.message, /run {5}: \/pd:plan 18248/);
        // The ceiling for the phase the step opens, from budget.turns. Read
        // from the defaults rather than pinned, for the same reason as `next`.
        const { get, load } = await import('../lib/config.js');
        const turns = get(await load({}), 'budget.turns.plan');
        assert.match(decision.message, new RegExp(`budget {2}: about ${turns} turns, then a fresh session`));
      });
    });

    test('but a terminal issue is not a reason to talk', async () => {
      await stop({ worktree: WORKTREE, home });
      await transition(18249, 'triaged', { home });
      await transition(18249, 'abandoned', { home });

      await onBranch('DESKTOP-18249/gone', async () => {
        assert.equal((await startSession()).message, undefined);
      });
    });

    test('nor is an issue nothing has been recorded about', async () => {
      await stop({ worktree: WORKTREE, home });

      await onBranch('DESKTOP-11111/unknown', async () => {
        assert.equal((await startSession()).message, undefined);
      });
    });
  });
});

describe('before compaction', () => {
  test('the active task is written to the journal rather than injected', async () => {
    const decision = await sessionStart({ cwd: WORKTREE }, { event: 'pre-compact', pluginRoot: '' });

    assert.equal(decision.block, false);
    assert.equal(decision.message, undefined);

    const entry = (await readJournal({ issue: ISSUE, event: 'compact' }, { home })).at(-1);
    assert.match(entry.detail, /T1 active, issue triaged/);
  });
});

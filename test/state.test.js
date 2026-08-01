// SPDX-License-Identifier: Apache-2.0

// Tests for lib/state.js.
//
// canTransition and the TRANSITIONS table are real code already, so most of
// this file is a real test rather than a contract. That is deliberate: the
// transition table is the thing that makes "the gate only opens from
// preflight-green" a property of the system instead of a promise, and a typo in
// it would be invisible until the wrong push succeeded.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TRANSITIONS,
  GATE_ELIGIBLE,
  adopt,
  allocateCounter,
  allocateRequirement,
  canTransition,
  exists,
  freezeRequirements,
  read,
  setOwns,
  transition,
} from '../lib/state.js';
import { read as readJournal } from '../lib/journal.js';

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-state-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('transition table integrity', () => {
  test('every target state is itself a known state', () => {
    const known = new Set(Object.keys(TRANSITIONS));
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(known.has(to), `${from} -> ${to}: "${to}" is not a state`);
      }
    }
  });

  test('terminal states have no way out', () => {
    assert.deepEqual(TRANSITIONS.merged, []);
    assert.deepEqual(TRANSITIONS.abandoned, []);
  });

  test('every non-terminal state is reachable from new', () => {
    const reached = new Set(['new']);
    const queue = ['new'];
    while (queue.length) {
      for (const next of TRANSITIONS[queue.shift()]) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    for (const state of Object.keys(TRANSITIONS)) {
      assert.ok(reached.has(state), `${state} is unreachable from new`);
    }
  });

  test('gate-eligible states exist in the table, for every kind of write', () => {
    for (const [kind, states] of Object.entries(GATE_ELIGIBLE)) {
      assert.ok(states.length > 0, `${kind} can never be issued`);
      for (const state of states) {
        assert.ok(state in TRANSITIONS, `${state} is gate-eligible for ${kind} but not a state`);
      }
    }
  });
});

describe('canTransition', () => {
  test('allows the documented path', () => {
    assert.equal(canTransition('new', 'triaged'), true);
    assert.equal(canTransition('preflight-green', 'pr-open'), true);
    assert.equal(canTransition('pr-open', 'merged'), true);
  });

  // The point of the machine: no shortcut from triage to an open PR, however
  // convinced anything is that the change is trivial.
  test('refuses to skip the middle', () => {
    assert.equal(canTransition('triaged', 'pr-open'), false);
    assert.equal(canTransition('planned', 'implemented'), false);
    assert.equal(canTransition('new', 'merged'), false);
  });

  test('refuses to leave a terminal state', () => {
    assert.equal(canTransition('merged', 'pr-open'), false);
    assert.equal(canTransition('abandoned', 'triaged'), false);
  });

  test('an unknown state is not a crash', () => {
    assert.equal(canTransition('nonsense', 'triaged'), false);
  });

  test('the quickfix route still passes through preflight-green', () => {
    assert.equal(canTransition('triaged', 'quickfix'), true);
    assert.equal(canTransition('quickfix', 'preflight-green'), true);
    assert.equal(canTransition('quickfix', 'pr-open'), false);
  });

  // Escalation: a quickfix that outgrew its thresholds goes back to triage
  // rather than sideways into planning, so requirements are rebuilt from the
  // issue instead of from the diff that already exists.
  test('quickfix can only escalate backwards to triaged', () => {
    assert.equal(canTransition('quickfix', 'triaged'), true);
    assert.equal(canTransition('quickfix', 'planned'), false);
  });
});

describe('persistence', () => {
  // Reading an issue nobody has touched must not create anything: a state
  // directory that appears because someone looked at it makes "which issues am
  // I working on" unanswerable.
  test('an unknown issue reads as new without being created', async () => {
    const record = await read(101, { home });
    assert.equal(record.state, 'new');
    assert.equal(record.createdAt, null);
    assert.equal(await exists(101, { home }), false);
  });

  test('read returns the stored record', async () => {
    await transition(101, 'triaged', { home, reason: 'bug, standard' });

    const record = await read(101, { home });
    assert.equal(record.state, 'triaged');
    assert.equal(record.issue, 101);
    assert.ok(record.createdAt);
    assert.deepEqual(
      record.history.map((step) => `${step.from}->${step.to}`),
      ['new->triaged'],
    );
  });

  test('transition rejects a move the table forbids', async () => {
    const result = await transition(101, 'merged', { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /not an allowed transition/);
    // And the refusal changed nothing.
    assert.equal((await read(101, { home })).state, 'triaged');
  });

  test('an unknown target state is refused by name', async () => {
    const result = await transition(101, 'shipped-it', { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /is not a state/);
  });

  test('an accepted transition lands in the journal', async () => {
    const entries = await readJournal({ issue: 101 }, { home });
    assert.deepEqual(
      entries.map((entry) => entry.event),
      ['triaged'],
    );
    assert.match(entries[0].detail, /bug, standard/);
  });

  test('approvals are recorded with who gave them', async () => {
    await transition(101, 'planned', { home });
    await transition(101, 'plan-approved', { home, approvedBy: 'human' });

    const record = await read(101, { home });
    assert.equal(record.approvals['plan-approved'].by, 'human');
    assert.ok(record.approvals['plan-approved'].at);
  });

  test('a corrupted record is an error, not an empty state', async () => {
    await mkdir(join(home, 'issues', '102'), { recursive: true });
    await writeFile(join(home, 'issues', '102', 'state.json'), '{ not json');

    await assert.rejects(() => read(102, { home }), /not readable JSON/);
  });
});

describe('the route', () => {
  test('taking the quickfix route records it', async () => {
    await transition(201, 'triaged', { home });
    await transition(201, 'quickfix', { home });
    assert.equal((await read(201, { home })).route, 'quickfix');
  });

  // Escalation has to clear the route, or an issue that outgrew quickfix could
  // never allocate the R-IDs it now needs.
  test('escalating back to triage clears it', async () => {
    await transition(201, 'triaged', { home, reason: 'outgrew the thresholds' });
    assert.equal((await read(201, { home })).route, null);
  });

  test('planning records the standard route', async () => {
    await transition(201, 'planned', { home });
    assert.equal((await read(201, { home })).route, 'standard');
  });

  test('triage can name a route, and only a real one', async () => {
    await transition(202, 'triaged', { home, route: 'multi-slice' });
    assert.equal((await read(202, { home })).route, 'multi-slice');

    const refused = await transition(202, 'planned', { home, route: 'sideways' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not a route/);
  });

  // Overwriting it with `standard` would erase the one thing that makes this
  // issue's history legible: that the work has been tried before.
  test('planning keeps the route triage chose', async () => {
    assert.equal((await read(202, { home })).route, 'multi-slice');
    await transition(202, 'planned', { home });
    assert.equal((await read(202, { home })).route, 'multi-slice');
  });
});

describe('the redo route cannot skip the archaeology', () => {
  test('planning is refused until the previous attempt has been looked up', async () => {
    await transition(203, 'triaged', { home, route: 'redo' });

    const refused = await transition(203, 'planned', { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /the previous attempt has not been looked up/);
    assert.match(refused.error, /pdkit issue history 203/);

    // And the issue did not move.
    assert.equal((await read(203, { home })).state, 'triaged');
  });

  test('the quickfix route is refused for the same reason', async () => {
    const refused = await transition(203, 'quickfix', { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /has not been looked up/);
  });

  test('once the facts exist the route proceeds', async () => {
    // Written by `pdkit issue history`, and only from a real lookup: prose
    // cannot produce this file, which is what the ordering rests on.
    await mkdir(join(home, 'issues', '203'), { recursive: true });
    await writeFile(join(home, 'issues', '203', 'archaeology.json'), JSON.stringify({ issue: 203, attempt: null }));

    const moved = await transition(203, 'planned', { home });
    assert.equal(moved.ok, true);
    assert.equal((await read(203, { home })).route, 'redo');
  });

  test('nothing else is held up by it', async () => {
    await transition(204, 'triaged', { home, route: 'standard' });
    assert.equal((await transition(204, 'planned', { home })).ok, true);
  });
});

describe('allocation', () => {
  test('requirement numbers are handed out in order', async () => {
    await transition(301, 'triaged', { home });
    assert.deepEqual(await allocateRequirement(301, { home }), { ok: true, value: 1 });
    assert.deepEqual(await allocateRequirement(301, { home }), { ok: true, value: 2 });
    assert.deepEqual((await read(301, { home })).requirements.ids, ['R1', 'R2']);
  });

  test('freezing refuses further allocation', async () => {
    const frozen = await freezeRequirements(301, { home });
    assert.deepEqual(frozen.ids, ['R1', 'R2']);

    const refused = await allocateRequirement(301, { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /frozen/);
  });

  // The counter is monotonic and the id list is what was actually handed out,
  // so a requirement dropped during planning leaves a gap that stays a gap.
  test('a gap left by a dropped requirement is never refilled', async () => {
    const file = join(home, 'issues', '301', 'state.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.requirements = { ids: ['R1'], next: 3, frozen: false };
    await writeFile(file, JSON.stringify(record));

    assert.deepEqual(await allocateRequirement(301, { home }), { ok: true, value: 3 });
  });

  test('the quickfix route allocates nothing', async () => {
    await transition(302, 'triaged', { home });
    await transition(302, 'quickfix', { home });

    const refused = await allocateRequirement(302, { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /quickfix/);
  });

  test('task and slice counters start at one', async () => {
    assert.deepEqual(await allocateCounter(303, 'task', { home }), { ok: true, value: 1 });
    assert.deepEqual(await allocateCounter(303, 'task', { home }), { ok: true, value: 2 });
    assert.deepEqual(await allocateCounter(303, 'slice', { home }), { ok: true, value: 1 });
  });

  test('an unknown counter is refused', async () => {
    const refused = await allocateCounter(303, 'sprint', { home });
    assert.equal(refused.ok, false);
  });

  test('owns is recorded per task', async () => {
    await setOwns(303, 'T1', ['packages/main/src/a.ts'], { home });
    assert.deepEqual((await read(303, { home })).owns.T1, ['packages/main/src/a.ts']);
  });
});

describe('adopting work that predates the plugin', () => {
  // Scenario 5 assumes an issue the plugin has been carrying. The common case
  // is the opposite: #17577 was open for two months while its issue read `new`,
  // and walking it through the chain to make the record agree would have meant
  // writing a plan nobody planned.
  test('records what is true and says the artefacts were never produced', async () => {
    const adopted = await adopt(401, {
      state: 'pr-open',
      pr: 17577,
      branch: 'DESKTOP-401/work',
      reason: 'opened before the plugin existed',
      home,
    });

    assert.equal(adopted.ok, true);

    const record = await read(401, { home });
    assert.equal(record.state, 'pr-open');
    assert.equal(record.route, 'standard');
    assert.equal(record.adopted.pr, 17577);
    assert.match(record.adopted.reason, /before the plugin existed/);

    // The history says the machine met the work here. It does not claim the
    // states in between were passed.
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0].from, 'new');
    assert.match(record.history[0].reason, /^adopted:/);

    // And nothing was invented on the way.
    assert.deepEqual(record.requirements.ids, []);
    assert.deepEqual(record.owns, {});
  });

  test('the reason is required, because it is the only account of where the work came from', async () => {
    const refused = await adopt(402, { state: 'pr-open', reason: '   ', home });

    assert.equal(refused.ok, false);
    assert.match(refused.error, /needs a reason/);
    assert.equal((await read(402, { home })).state, 'new');
  });

  test('a live record is never adopted over', async () => {
    await transition(403, 'triaged', { home });
    const refused = await adopt(403, { state: 'pr-open', reason: 'looks similar', home });

    assert.equal(refused.ok, false);
    assert.match(refused.error, /already at triaged/);
    assert.equal((await read(403, { home })).state, 'triaged', 'the record it refused to move is untouched');
  });

  test('the state and route have to be real', async () => {
    assert.match((await adopt(404, { state: 'halfway', reason: 'x', home })).error, /not a state/);
    assert.match((await adopt(404, { state: 'pr-open', route: 'sideways', reason: 'x', home })).error, /not a route/);
  });

  test('an adopted issue moves on like any other', async () => {
    await adopt(405, { state: 'pr-open', reason: 'pre-existing', home });
    const moved = await transition(405, 'review-in-progress', { home });

    assert.equal(moved.ok, true);
    // The mark stays: it is why there is no plan, and that stays true.
    assert.ok((await read(405, { home })).adopted);
  });
});

// SPDX-License-Identifier: Apache-2.0

// Tests for lib/state.js.
//
// canTransition and the TRANSITIONS table are real code already, so most of
// this file is a real test rather than a contract. That is deliberate: the
// transition table is the thing that makes "the gate only opens from
// preflight-green" a property of the system instead of a promise, and a typo in
// it would be invisible until the wrong push succeeded.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TRANSITIONS, GATE_ELIGIBLE, canTransition, read, transition } from '../lib/state.js';

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

  test('gate-eligible states exist in the table', () => {
    for (const state of GATE_ELIGIBLE) {
      assert.ok(state in TRANSITIONS, `${state} is gate-eligible but not a state`);
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

describe('persistence', { todo: true }, () => {
  test('read returns the stored record', { todo: true }, async () => {
    await read(1);
  });

  test('transition rejects a move the table forbids', { todo: true }, async () => {
    const result = await transition(1, 'merged');
    assert.equal(result.ok, false);
  });
});

// SPDX-License-Identifier: Apache-2.0

// Tests for lib/hooks/rules.js.
//
// The rules are data, which makes their structure checkable now, before the
// dispatcher that consumes them exists. Two properties here are load-bearing
// rather than cosmetic: rule order, and the presence of a remedy in every deny
// message.
//
// Not in the planned file list — added because the ordering property below has
// no other place to be asserted, and getting it wrong silently weakens the
// force-push rule.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RULES } from '../lib/hooks/rules.js';

describe('rule shape', () => {
  test('ids are unique', () => {
    const ids = RULES.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every rule is complete', () => {
    for (const rule of RULES) {
      assert.ok(rule.id, 'missing id');
      assert.ok(rule.program, `${rule.id}: missing program`);
      assert.ok(Array.isArray(rule.argPrefix), `${rule.id}: argPrefix must be an array`);
      assert.ok(['deny', 'gate'].includes(rule.action), `${rule.id}: bad action`);
      assert.ok(rule.reason, `${rule.id}: missing reason`);
    }
  });

  // A deny that only says no gets retried in a slightly different shape. Every
  // refusal has to point somewhere.
  test('every deny message says what to do instead', () => {
    for (const rule of RULES.filter((r) => r.action === 'deny')) {
      assert.ok(
        rule.reason.length > 40,
        `${rule.id}: reason is too short to contain an alternative`,
      );
    }
  });
});

describe('rule order', () => {
  // First match wins, so the narrower rule has to come first. Reversed, a valid
  // gate token would let a --force push through, which is the one thing that is
  // refused unconditionally.
  test('force-push is checked before the general push gate', () => {
    const force = RULES.findIndex((rule) => rule.id === 'force-push-without-lease');
    const push = RULES.findIndex((rule) => rule.id === 'push');
    assert.ok(force !== -1 && push !== -1, 'both rules must exist');
    assert.ok(force < push, 'force-push rule must precede the push gate rule');
  });
});

describe('coverage of section 6', () => {
  const required = [
    'force-push-without-lease',
    'push',
    'gh-pr-write',
    'gh-issue-comment',
    'gh-api-write',
    'add-all',
    'interactive-rebase',
    'no-verify',
  ];

  for (const id of required) {
    test(`${id} is present`, () => {
      assert.ok(
        RULES.some((rule) => rule.id === id),
        `rule "${id}" from spec section 6 is missing`,
      );
    });
  }

  test('every GitHub write goes through the gate, never a bare allow', () => {
    for (const rule of RULES.filter((r) => r.program === 'gh')) {
      assert.equal(rule.action, 'gate', `${rule.id}: gh writes must be gated`);
    }
  });
});

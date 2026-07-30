// SPDX-License-Identifier: Apache-2.0

// Contract for lib/ids.js.
//
// The properties asserted here are the ones that make traceability worth
// having: R-IDs are allocated once, never renumbered, and never derived from a
// diff that already exists.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateRequirement,
  freezeRequirements,
  allocateTask,
  allocateSlice,
  branchName,
} from '../lib/ids.js';

describe('requirement IDs', () => {
  test('allocate in order without reuse', { todo: true }, async () => {
    assert.equal(await allocateRequirement(1), 'R1');
    assert.equal(await allocateRequirement(1), 'R2');
  });

  // Renumbering breaks requirement -> task -> commit -> PR table all at once,
  // and the break is silent: every link still looks like a link.
  test('freezing blocks further allocation', { todo: true }, async () => {
    await freezeRequirements(1);
    await assert.rejects(() => allocateRequirement(1));
  });

  test('a gap left by a removed requirement is never refilled', { todo: true }, async () => {
    // R2 removed during planning; the next allocation is R4, not R2.
    assert.equal(await allocateRequirement(2), 'R4');
  });

  test('the quickfix route allocates nothing', { todo: true }, async () => {
    await assert.rejects(() => allocateRequirement(3), /quickfix/);
  });
});

describe('task and slice IDs', () => {
  test('tasks are T-prefixed and sequential', { todo: true }, async () => {
    assert.equal(await allocateTask(1), 'T1');
  });

  test('slices are numbered from 1 in merge order', { todo: true }, async () => {
    assert.equal(await allocateSlice(1), 1);
  });
});

describe('branchName', () => {
  test('single-slice form omits the index', { todo: true }, () => {
    assert.equal(
      branchName({ issue: 12345, slug: 'high-contrast-themes' }),
      'DESKTOP-12345/high-contrast-themes',
    );
  });

  test('sliced form carries the index', { todo: true }, () => {
    assert.equal(
      branchName({ issue: 12345, index: 2, slug: 'main-exec-plumbing' }),
      'DESKTOP-12345/2-main-exec-plumbing',
    );
  });

  // preflight checks the branch name against this pattern, so the two have to
  // agree or every PR fails its own gate.
  test('output matches the pattern preflight enforces', { todo: true }, () => {
    const pattern = /^DESKTOP-\d+\/(\d+-)?[a-z0-9-]+$/;
    assert.match(branchName({ issue: 1, slug: 'x' }), pattern);
    assert.match(branchName({ issue: 1, index: 3, slug: 'x-y' }), pattern);
  });
});

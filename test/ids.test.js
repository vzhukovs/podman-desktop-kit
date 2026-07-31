// SPDX-License-Identifier: Apache-2.0

// Contract for lib/ids.js.
//
// The properties asserted here are the ones that make traceability worth
// having: R-IDs are allocated once, never renumbered, and never derived from a
// diff that already exists.
//
// The assertions come from the contract written before the implementation; the
// fixtures are new. Each case needs an issue in a specific condition — frozen,
// on the quickfix route, carrying a gap — and those conditions only exist once
// there is a record to put them in.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRANCH_PATTERN,
  allocateRequirement,
  freezeRequirements,
  allocateTask,
  allocateSlice,
  branchName,
  parseBranch,
  slugify,
} from '../lib/ids.js';
import { transition } from '../lib/state.js';

let home;

/**
 * Put an issue into a condition directly, without walking it there through the
 * state machine.
 *
 * @param {number} issue
 * @param {Record<string, unknown>} record
 */
async function fixture(issue, record) {
  await mkdir(join(home, 'issues', String(issue)), { recursive: true });
  await writeFile(
    join(home, 'issues', String(issue), 'state.json'),
    JSON.stringify({ issue, state: 'planned', createdAt: new Date().toISOString(), ...record }),
  );
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-ids-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('requirement IDs', () => {
  test('allocate in order without reuse', async () => {
    await transition(1, 'triaged', { home });
    assert.equal(await allocateRequirement(1, { home }), 'R1');
    assert.equal(await allocateRequirement(1, { home }), 'R2');
  });

  // Renumbering breaks requirement -> task -> commit -> PR table all at once,
  // and the break is silent: every link still looks like a link.
  test('freezing blocks further allocation', async () => {
    assert.deepEqual(await freezeRequirements(1, { home }), ['R1', 'R2']);
    await assert.rejects(() => allocateRequirement(1, { home }), /frozen/);
  });

  test('a gap left by a removed requirement is never refilled', async () => {
    // R2 removed during planning; the next allocation is R4, not R2.
    await fixture(2, { requirements: { ids: ['R1', 'R3'], next: 4, frozen: false } });
    assert.equal(await allocateRequirement(2, { home }), 'R4');
  });

  test('the quickfix route allocates nothing', async () => {
    await fixture(3, { state: 'quickfix', route: 'quickfix' });
    await assert.rejects(() => allocateRequirement(3, { home }), /quickfix/);
  });
});

describe('task and slice IDs', () => {
  test('tasks are T-prefixed and sequential', async () => {
    assert.equal(await allocateTask(1, { home }), 'T1');
    assert.equal(await allocateTask(1, { home }), 'T2');
  });

  test('slices are numbered from 1 in merge order', async () => {
    assert.equal(await allocateSlice(1, { home }), 1);
    assert.equal(await allocateSlice(1, { home }), 2);
  });
});

describe('branchName', () => {
  test('single-slice form omits the index', () => {
    assert.equal(
      branchName({ issue: 12345, slug: 'high-contrast-themes' }),
      'DESKTOP-12345/high-contrast-themes',
    );
  });

  test('sliced form carries the index', () => {
    assert.equal(
      branchName({ issue: 12345, index: 2, slug: 'main-exec-plumbing' }),
      'DESKTOP-12345/2-main-exec-plumbing',
    );
  });

  // preflight checks the branch name against this pattern, so the two have to
  // agree or every PR fails its own gate.
  //
  // Asserted by behaviour rather than by comparing the pattern to a copy of
  // itself: a second literal in this file is exactly the duplication exporting
  // BRANCH_PATTERN exists to prevent, and it fails on any edit including a
  // correct one.
  test('output matches the pattern preflight enforces', () => {
    assert.match(branchName({ issue: 1, slug: 'x' }), BRANCH_PATTERN);
    assert.match(branchName({ issue: 1, index: 3, slug: 'x-y' }), BRANCH_PATTERN);
  });

  test('the pattern accepts our branches and nothing else', () => {
    for (const name of ['DESKTOP-1/x', 'DESKTOP-12345/2-main-exec-plumbing', 'DESKTOP-7/fix-17221']) {
      assert.match(name, BRANCH_PATTERN, `${name} should be accepted`);
    }
    for (const name of ['main', 'DESKTOP-1', 'DESKTOP-1/', 'desktop-1/x', 'DESKTOP-x/y', 'DESKTOP-1/Mixed-Case']) {
      assert.doesNotMatch(name, BRANCH_PATTERN, `${name} should be rejected`);
    }
  });
});

// The gate uses this to check a branch belongs to the issue a token is asked
// for, so it has to take apart exactly what branchName puts together.
describe('parseBranch', () => {
  test('round-trips what branchName produces', () => {
    assert.deepEqual(parseBranch(branchName({ issue: 12345, slug: 'fix-the-thing' })), {
      issue: 12345,
      index: null,
      slug: 'fix-the-thing',
    });
    assert.deepEqual(parseBranch(branchName({ issue: 12345, index: 2, slug: 'main-exec-plumbing' })), {
      issue: 12345,
      index: 2,
      slug: 'main-exec-plumbing',
    });
  });

  // A slug may start with digits; only digits followed by a dash are an index.
  test('tells a slice index from a slug that begins with digits', () => {
    assert.deepEqual(parseBranch('DESKTOP-1/2fix'), { issue: 1, index: null, slug: '2fix' });
    assert.deepEqual(parseBranch('DESKTOP-1/12-34-x'), { issue: 1, index: 12, slug: '34-x' });
  });

  test('returns null for anything that is not one of ours', () => {
    for (const name of ['main', 'DESKTOP-1', 'feature/x', '', 'DESKTOP-1/UPPER']) {
      assert.equal(parseBranch(name), null, `${name} should not parse`);
    }
  });

  test('a title becomes a usable slug', () => {
    assert.equal(slugify('High-contrast themes: Windows only!'), 'high-contrast-themes-windows-only');
    assert.equal(branchName({ issue: 7, slug: 'Fix "podman machine" start' }), 'DESKTOP-7/fix-podman-machine-start');
  });

  test('a slug that normalizes to nothing is refused', () => {
    assert.throws(() => branchName({ issue: 7, slug: '???' }), /slug/);
  });
});

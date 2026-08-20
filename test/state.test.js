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
import { BODY_DEPENDENT, CHECK_IDS } from '../lib/preflight/index.js';
import { write } from '../lib/preflight/record.js';
import { preflightGreen } from './helpers/preflight-evidence.js';

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

// Measured on #18284: a real, reproducible bug in podman-desktop whose cause is
// a version skew between the podman client and the machine it drives. Nothing
// in this repository to change, and a reproduction, a detector and a workaround
// to publish. Walking it through the machine as it stood produced "not finished
// — no pull request was ever opened", which is true and about nothing.
describe('an issue whose deliverable is an answer, not a diff', () => {
  const captured = async (issue) => {
    await mkdir(join(home, 'issues', String(issue), 'validation'), { recursive: true });
    await writeFile(join(home, 'issues', String(issue), 'validation', 'V1.md'), '# RECEIPT V1\n');
  };

  test('answered is refused while nothing has been captured', async () => {
    await transition(601, 'triaged', { home, route: 'standard' });

    const refused = await transition(601, 'answered', { home, reason: 'client/server skew' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /nothing captured/);
    assert.match(refused.error, /pdkit validate attach/);
    assert.equal((await read(601, { home })).state, 'triaged');
  });

  test('and refused without a reason once it has been', async () => {
    await captured(601);

    const refused = await transition(601, 'answered', { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /--reason is required/);
  });

  test('with both, the issue can say what it is', async () => {
    const moved = await transition(601, 'answered', { home, reason: 'version skew across the machine boundary' });
    assert.equal(moved.ok, true);
  });

  // The correction the measurement made to the design. The obvious move was a
  // terminal state meaning "settled without a diff", and the moment findings
  // are posted the issue is not settled — it is waiting on the reporter, which
  // is exactly where #18284 sits.
  test('answered is not terminal, and its exits are the three that happen', () => {
    assert.deepEqual(TRANSITIONS['answered'], ['resolved', 'planned', 'abandoned']);
  });

  test('resolved is terminal and is not merged', async () => {
    assert.deepEqual(TRANSITIONS['resolved'], []);

    const moved = await transition(601, 'resolved', { home, reason: 'the reporter confirmed' });
    assert.equal(moved.ok, true);
    assert.equal((await read(601, { home })).state, 'resolved');
    assert.equal((await transition(601, 'merged', { home })).ok, false, 'terminal is terminal');
  });

  // An answer that implies product work is not the end of the issue.
  test('the other exit leads back to planning', async () => {
    await transition(602, 'triaged', { home, route: 'standard' });
    await captured(602);
    await transition(602, 'answered', { home, reason: 'environmental, and the product says nothing about it' });

    assert.equal((await transition(602, 'planned', { home })).ok, true);
  });

  test('nothing else has to be captured to move', async () => {
    await transition(603, 'triaged', { home, route: 'standard' });
    assert.equal((await transition(603, 'planned', { home })).ok, true, 'the demand belongs to `answered` alone');
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

// The hole under the hard rule. Section 1 says a push token is issued from
// `preflight-green` and nowhere else, and the gate did check it — but nothing
// checked that the state was true. `slices-approved -> preflight-green` is a
// legal move, so the whole chain of gates could be replaced by typing the name
// of its outcome. Walked into on DESKTOP-18832, where a session set it by hand
// after the slice graph landed, opened a token, and pushed.
describe('preflight-green has to be earned', () => {
  /** Walk to the state just before it, without producing any evidence. */
  async function atSlicesApproved(issue) {
    for (const to of ['triaged', 'planned', 'plan-approved', 'implemented', 'validated', 'audited', 'sliced', 'slices-approved']) {
      const result = await transition(issue, to, { home });
      assert.ok(result.ok, `${to}: ${result.error}`);
    }
  }

  test('typing the name of the state is refused', async () => {
    await atSlicesApproved(700);

    const result = await transition(700, 'preflight-green', { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /has not been shown to be ready to publish/);
    assert.match(result.error, /preflight has never run/);
    // And it says what to run, because a refusal that does not is a refusal
    // people work around rather than satisfy.
    assert.match(result.error, /pdkit preflight 700/);
  });

  test('a green run with the body earns it', async () => {
    await atSlicesApproved(701);
    await preflightGreen(701, { home });

    assert.equal((await transition(701, 'preflight-green', { home })).ok, true);
  });

  // The second pass is what makes a green, and the first alone does not: four
  // checks read the pull request body, and without it they have judged nothing.
  test('a green run that never saw the pull request body does not', async () => {
    await atSlicesApproved(702);
    await write({
      issue: 702,
      report: { ok: true, results: CHECK_IDS.map((id) => ({ id, status: 'pass', blocking: true, summary: 'ok' })) },
      context: { branch: null, slice: null, headSha: null, baseInfo: null, prBody: null },
      bodyDependent: BODY_DEPENDENT,
      home,
    });

    const result = await transition(702, 'preflight-green', { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /only ever run without the pull request body/);
  });

  test('a blocking failure is not readiness, however recent', async () => {
    await atSlicesApproved(703);
    await write({
      issue: 703,
      report: {
        ok: false,
        results: CHECK_IDS.map((id) => ({ id, status: id === 'tests' ? 'fail' : 'pass', blocking: true, summary: id === 'tests' ? 'two specs red' : 'ok' })),
      },
      context: { branch: null, slice: null, headSha: null, baseInfo: null, prBody: 'body' },
      bodyDependent: BODY_DEPENDENT,
      home,
    });

    const result = await transition(703, 'preflight-green', { home });
    assert.equal(result.ok, false);
    assert.match(result.error, /tests failed: two specs red/);
  });

  // Green on a diff that has since moved is the false evidence lib/evidence.js
  // was written against, and the slice verifier already refuses it by digest.
  test('a green run of a commit that is no longer checked out does not count', async () => {
    await atSlicesApproved(704);
    await preflightGreen(704, { home, head: 'a'.repeat(40) });

    const stale = await transition(704, 'preflight-green', { home, head: 'b'.repeat(40) });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /a green run of a diff that has since moved/);

    // The same evidence, asked about the commit it was taken on.
    assert.equal((await transition(704, 'preflight-green', { home, head: 'a'.repeat(40) })).ok, true);
  });

  // Two passes, neither complete alone: the merged view is the question.
  test('the body pass completes the first one rather than replacing it', async () => {
    await atSlicesApproved(705);
    const head = 'c'.repeat(40);

    await write({
      issue: 705,
      report: { ok: true, results: CHECK_IDS.map((id) => ({ id, status: 'pass', blocking: true, summary: 'ok' })) },
      context: { branch: null, slice: null, headSha: head, baseInfo: null, prBody: null },
      bodyDependent: BODY_DEPENDENT,
      home,
    });
    assert.equal((await transition(705, 'preflight-green', { home, head })).ok, false);

    // --body-only re-runs exactly the four, with the body in hand.
    await write({
      issue: 705,
      report: { ok: true, results: BODY_DEPENDENT.map((id) => ({ id, status: 'pass', blocking: true, summary: 'ok' })) },
      context: { branch: null, slice: null, headSha: head, baseInfo: null, prBody: 'body' },
      bodyDependent: BODY_DEPENDENT,
      home,
    });

    assert.equal((await transition(705, 'preflight-green', { home, head })).ok, true);
  });

  // Adoption is the deliberate exception: work that predates the plugin never
  // ran preflight, and inventing the artefacts of the states it skipped is the
  // thing `adopt` exists not to do.
  test('adopted work is not asked for evidence it was never going to have', async () => {
    const adopted = await adopt(706, { state: 'preflight-green', reason: 'pushed before the plugin existed', home });
    assert.equal(adopted.ok, true);
    assert.equal((await read(706, { home })).state, 'preflight-green');
  });
});

describe('the review rejected the approach', () => {
  /** Walk an issue to an open pull request with a frozen requirement set. */
  async function published(issue) {
    // preflight-green is on the way, and it is no longer free.
    await preflightGreen(issue, { home });
    await transition(issue, 'triaged', { home });
    await transition(issue, 'planned', { home });
    await allocateRequirement(issue, { home });
    await allocateRequirement(issue, { home });
    await freezeRequirements(issue, { home });
    for (const to of ['plan-approved', 'implemented', 'validated', 'audited', 'sliced', 'slices-approved', 'preflight-green', 'pr-open']) {
      await transition(issue, to, { home });
    }
  }

  // #17577: a maintainer named a different design in the review body. The only
  // moves the machine had were "push again", which assumes the design survived,
  // and "abandon", which throws away an issue still worth doing.
  test('an open pull request can go back to triage', async () => {
    await published(501);

    const back = await transition(501, 'triaged', { home, reason: 'rework: the approach was refused' });
    assert.equal(back.ok, true);

    const record = await read(501, { home });
    assert.equal(record.state, 'triaged');
    assert.equal(record.route, null, 'the route is chosen again, from the issue');
  });

  test('the requirement set thaws, and keeps every number it had', async () => {
    const record = await read(501, { home });

    assert.equal(record.requirements.frozen, false);
    // An R-ID means one thing forever; a rework may add to the set and may
    // never renumber it.
    assert.deepEqual(record.requirements.ids, ['R1', 'R2']);
    assert.equal(record.requirements.next, 3);
  });

  test('it is refused without a reason, because nothing else on disk says why', async () => {
    await published(502);

    const refused = await transition(502, 'triaged', { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /a rework needs --reason/);
    assert.equal((await read(502, { home })).state, 'pr-open', 'a refused transition changes nothing');
  });

  test('the same door exists from review-in-progress', async () => {
    await published(503);
    await transition(503, 'review-in-progress', { home });

    assert.equal((await transition(503, 'triaged', { home, reason: 'rework: wrong layer' })).ok, true);
  });

  // Planning has to start from the issue, not from the diff that was refused.
  test('it lands on triaged rather than jumping into planning', async () => {
    assert.ok(!TRANSITIONS['pr-open'].includes('planned'));
    assert.ok(!TRANSITIONS['review-in-progress'].includes('planned'));
  });

  test('an ordinary transition still needs no reason', async () => {
    await published(504);
    assert.equal((await transition(504, 'review-in-progress', { home })).ok, true);
  });
});

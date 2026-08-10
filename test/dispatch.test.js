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

// Tests for lib/hooks/dispatch.js — the whole path, from a hook payload to a
// decision.
//
// rules.test.js already covers which rule a line trips. What is asserted here
// is everything that needs the world: which branch a write lands on, whether a
// token exists for that branch, that allowing spends it, and that a failure
// anywhere in that chain refuses instead of allowing.
//
// The last one is the reason this file exists. lib/cli.js allows a Bash call
// when a handler throws, on purpose; if that policy reached inside the gate, a
// crash would read as consent.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { handle } from '../lib/hooks/dispatch.js';
import * as journal from '../lib/journal.js';
import * as gate from '../lib/gate.js';
import { transition } from '../lib/state.js';

const run = promisify(execFile);

const BRANCH = 'DESKTOP-2001/fix-the-thing';

let home;
let repo;
let previousHome;

/** A PreToolUse payload for a Bash call. */
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: repo });

/** Walk an issue to the only state a token is issued from. */
async function readyIssue(issue) {
  for (const to of [
    'triaged',
    'planned',
    'plan-approved',
    'implemented',
    'validated',
    'audited',
    'sliced',
    'slices-approved',
    'preflight-green',
  ]) {
    const result = await transition(issue, to, { home });
    assert.ok(result.ok, `could not reach ${to}: ${result.error}`);
  }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-dispatch-home-'));
  repo = await mkdtemp(join(tmpdir(), 'pdkit-dispatch-repo-'));

  // dispatch resolves $PDKIT_HOME the same way every other entry point does;
  // pointing the variable at a temporary directory exercises that path rather
  // than working around it.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;

  await run('git', ['init', '-q', '-b', BRANCH], { cwd: repo });

  await readyIssue(2001);
});

beforeEach(async () => {
  await gate.revokeAll({ home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;

  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe('what is not ours', () => {
  test('a call that is not Bash passes through', async () => {
    const decision = await handle({ tool_name: 'Read', tool_input: { file_path: '/x' } });
    assert.equal(decision.block, false);
  });

  test('an empty or missing command passes through', async () => {
    assert.equal((await handle(null)).block, false);
    assert.equal((await handle({ tool_name: 'Bash', tool_input: {} })).block, false);
    assert.equal((await handle(bash('   '))).block, false);
  });

  test('ordinary work passes through', async () => {
    for (const line of ['git status', 'pnpm test:unit', 'gh pr view 12', 'git commit -m x']) {
      assert.equal((await handle(bash(line))).block, false, `${line} was blocked`);
    }
  });
});

describe('unconditional refusals', () => {
  test('a force push is refused even with a valid token', async () => {
    const issued = await gate.open({ issue: 2001, branch: BRANCH, home });
    assert.equal(issued.ok, true);

    const decision = await handle(bash(`git push --force origin ${BRANCH}`));
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'force-push-without-lease');

    // And the token it did not use is still there.
    assert.equal((await gate.verify({ branch: BRANCH, home })).valid, true);
  });

  test('a refusal says what to do instead and quotes the command', async () => {
    const decision = await handle(bash('git add -A'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /List the paths explicitly/);
    assert.match(decision.reason, /command: git add -A/);
  });
});

describe('the gate', () => {
  test('a push without a token is refused', async () => {
    const decision = await handle(bash('git push'));
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'push');
    assert.match(decision.reason, /no consent token/);
  });

  test('a push with a token is allowed and spends it', async () => {
    await gate.open({ issue: 2001, branch: BRANCH, home });

    const first = await handle(bash('git push'));
    assert.equal(first.block, false);
    assert.match(first.message, /spent/);

    // One token, one push. The second attempt is a new decision.
    const second = await handle(bash('git push'));
    assert.equal(second.block, true);
    assert.match(second.reason, /already spent/);
  });

  test('an expired token does not allow', async () => {
    await gate.open({ issue: 2001, branch: BRANCH, ttlMs: -1, home });

    const decision = await handle(bash('git push'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /expired/);
  });

  // The reason targetBranch prefers the explicit form: consent for the feature
  // branch must not open a push to main from that same branch.
  test('a token does not cover a push to a different branch', async () => {
    await gate.open({ issue: 2001, branch: BRANCH, home });

    const decision = await handle(bash('git push origin main'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /no consent token for push main/);
  });

  test('the refspec is read through HEAD: and through -u', async () => {
    await gate.open({ issue: 2001, branch: BRANCH, home });
    assert.equal((await handle(bash(`git push origin HEAD:${BRANCH}`))).block, false);

    await gate.open({ issue: 2001, branch: BRANCH, home });
    assert.equal((await handle(bash(`git push -u origin ${BRANCH}`))).block, false);
  });

  test('gh pr create is gated on its head branch', async () => {
    const decision = await handle(bash('gh pr create --base main --head DESKTOP-2001/other --title x'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /no consent token for push DESKTOP-2001\/other/);

    await gate.open({ issue: 2001, branch: BRANCH, home });
    assert.equal((await handle(bash(`gh pr create --base main --head ${BRANCH} --title x`))).block, false);
  });

  // A wrapper program must not become a way past the gate.
  test('a wrapped push is gated exactly like a bare one', async () => {
    assert.equal((await handle(bash('nohup git push'))).block, true);

    await gate.open({ issue: 2001, branch: BRANCH, home });
    assert.equal((await handle(bash('nohup git push'))).block, false);
  });

  test('a chained push is gated', async () => {
    const decision = await handle(bash('pnpm test:unit && git push'));
    assert.equal(decision.block, true);
    assert.equal(decision.rule, 'push');
  });
});

describe('failing closed', () => {
  test('a push outside a repository is refused, not allowed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pdkit-dispatch-nogit-'));
    try {
      const decision = await handle({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: outside });
      assert.equal(decision.block, true);
      assert.match(decision.reason, /no branch to check/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // The case cli.js's fail-open policy would get wrong: a valid token exists,
  // the rule matched, and then something breaks. That must read as "no", not
  // as "yes". The token file is made read-only so spending it throws — a real
  // failure inside the gate rather than a simulated one.
  test('a failure while spending the token refuses', async () => {
    await gate.open({ issue: 2001, branch: BRANCH, home });
    const file = join(home, 'gates', `${encodeURIComponent(`push:${BRANCH}`)}.json`);

    await chmod(file, 0o400);
    try {
      const decision = await handle(bash('git push'));
      assert.equal(decision.block, true);
      assert.match(decision.reason, /could not be checked/);
    } finally {
      await chmod(file, 0o600);
    }
  });
});

describe('writes that belong to a pull request rather than a branch', () => {
  before(async () => {
    await readyIssue(2002);
    await transition(2002, 'pr-open', { home });
  });

  // The hole this closes. Before the token had a kind, every write with no
  // branch of its own fell back to the current branch — so a token issued to
  // push slice #1 authorised replying in a review, commenting on the issue,
  // and any gh api mutation, all without anyone confirming those.
  test('a push token does not authorise a review write', async () => {
    await readyIssue(2003);
    await gate.open({ issue: 2003, branch: BRANCH, kind: 'push', home });

    const decision = await handle(bash('gh pr review 17577 --approve'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /no consent token for reply #17577/);
  });

  test('a reply token for that pull request lets it through', async () => {
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });

    const decision = await handle(bash('gh pr comment 17577 --body "fixed"'));
    assert.equal(decision.block, false, decision.reason);
  });

  test('and does not cover another pull request', async () => {
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });

    const decision = await handle(bash('gh pr comment 17578 --body "fixed"'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /no consent token for reply #17578/);
  });

  // The batch is the unit of consent, so the token survives the first reply.
  test('the token is not spent on the first write', async () => {
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });

    assert.equal((await handle(bash('gh pr comment 17577 --body a'))).block, false);
    assert.equal((await handle(bash('gh pr comment 17577 --body b'))).block, false);
  });

  // A raw GraphQL mutation carries a thread id and no pull request number, so
  // there is nothing to check a token against. Refused with the command that
  // does work, rather than matched against whatever token is lying around.
  test('a mutation that names no pull request is refused with a remedy', async () => {
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });

    const decision = await handle(bash('gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \\"x\\"}) { thread { id } } }"'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /does not name a pull request/);
    assert.match(decision.reason, /pdkit pr reply --pr/);
  });

  test('commenting on an upstream issue is refused whatever token exists', async () => {
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });

    const decision = await handle(bash('gh issue comment 17221 --body "any update?"'));
    assert.equal(decision.block, true);
    assert.match(decision.reason, /human action/);
  });
});

// Until 0.23 a refusal left no trace anywhere. That made the two failures
// section 13 cares about indistinguishable after the fact: a gate that fired,
// and a gate that was never wired to fire. An empty journal meant both.
describe('a refusal is written down', () => {
  test('a blocked push reaches the journal, with the rule and the command', async () => {
    const before = (await journal.read({ event: 'denied' }, { home })).length;

    const decision = await handle(bash('git push origin main'));
    assert.equal(decision.block, true);

    const entries = await journal.read({ event: 'denied' }, { home });
    assert.equal(entries.length, before + 1);
    assert.match(entries.at(-1).detail, /^push: git push origin main/);
  });

  // Every Bash call goes through this handler. An entry per `ls` would bury the
  // few that matter under a session of noise.
  test('an allowed command writes nothing', async () => {
    const before = (await journal.read({ event: 'denied' }, { home })).length;

    assert.equal((await handle(bash('git status'))).block, false);
    assert.equal((await handle(bash('pnpm test:unit'))).block, false);

    assert.equal((await journal.read({ event: 'denied' }, { home })).length, before);
  });
});

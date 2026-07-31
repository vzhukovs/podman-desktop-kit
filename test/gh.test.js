// SPDX-License-Identifier: Apache-2.0

// Tests for lib/gh.js.
//
// gh is driven through an injected runner rather than the network, so what is
// asserted is the argv: which repository a read asks about, and what exactly
// would be sent to GitHub. Those are the details that are invisible until they
// are wrong in public — a read that quietly answered about the fork, or a body
// mangled on its way through a shell.
//
// The one behaviour worth more than the argv is the gate check, because the
// Bash hook cannot see a child process this module spawns.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPullRequest, fetchIssue, headRef, linkedPullRequests, upstreamSlug } from '../lib/gh.js';
import * as gate from '../lib/gate.js';
import { transition } from '../lib/state.js';

const CONFIG = {
  repo: { upstream: 'podman-desktop/podman-desktop', fork: 'vzhukovs/podman-desktop', base_branch: 'main' },
};

const BRANCH = 'DESKTOP-6001/fix-the-thing';

let home;
/** Every call the fake gh received. */
let calls;

/**
 * A stand-in for execFile that records the call and answers with canned output.
 *
 * @param {string} stdout
 * @param {Error|null} [error]
 */
function fakeGh(stdout, error = null) {
  return (file, args, options, callback) => {
    const call = { file, args, options, stdin: null };
    calls.push(call);
    queueMicrotask(() => callback(error, stdout, ''));
    return { stdin: { end: (text) => { call.stdin = text; } } };
  };
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-gh-'));

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
    await transition(6001, to, { home });
  }
});

beforeEach(async () => {
  calls = [];
  await gate.revokeAll({ home });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('addressing', () => {
  test('upstreamSlug and headRef read the configured repositories', () => {
    assert.equal(upstreamSlug(CONFIG), 'podman-desktop/podman-desktop');
    assert.equal(headRef(CONFIG, BRANCH), `vzhukovs:${BRANCH}`);
  });

  test('a config that does not name them is an error, not a guess', () => {
    assert.throws(() => upstreamSlug({}), /repo\.upstream/);
    assert.throws(() => headRef({ repo: { fork: 'nope' } }, 'x'), /repo\.fork/);
  });
});

describe('reads', () => {
  // gh infers the repository from the working directory. In a fork that
  // inference is wrong, and the wrongness is silent: it answers about the
  // fork's copy of the issue tracker instead of upstream's.
  test('fetchIssue asks upstream explicitly', async () => {
    await fetchIssue(17221, { config: CONFIG, exec: fakeGh('{"number":17221,"title":"x"}') });

    const [call] = calls;
    assert.equal(call.file, 'gh');
    assert.deepEqual(call.args.slice(0, 5), ['issue', 'view', '17221', '--repo', 'podman-desktop/podman-desktop']);
  });

  test('linkedPullRequests looks at every state, not just open ones', async () => {
    const prs = await linkedPullRequests(17221, {
      config: CONFIG,
      exec: fakeGh(
        JSON.stringify([
          { number: 1, state: 'MERGED', title: 'fix: the thing', url: 'u1', mergedAt: '2026-01-01T00:00:00Z' },
          { number: 2, state: 'MERGED', title: 'Revert "fix: the thing"', url: 'u2', mergedAt: null },
        ]),
      ),
    });

    assert.ok(calls[0].args.includes('--state'));
    assert.ok(calls[0].args.includes('all'));

    // A closed PR that was reverted is the signal for the redo route, and
    // looking only at open PRs would miss the case that most needs archaeology.
    assert.equal(prs[0].isRevert, false);
    assert.equal(prs[1].isRevert, true);
    assert.equal(prs[1].mergedAt, null);
  });

  test('gh failing is reported with what gh said', async () => {
    const failure = Object.assign(new Error('exit 1'), { code: 1 });
    await assert.rejects(
      () => fetchIssue(1, { config: CONFIG, exec: (f, a, o, cb) => queueMicrotask(() => cb(failure, '', 'could not resolve to an Issue')) }),
      /could not resolve to an Issue/,
    );
  });

  test('a missing gh says how to fix it', async () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    await assert.rejects(
      () => fetchIssue(1, { config: CONFIG, exec: (f, a, o, cb) => queueMicrotask(() => cb(missing, '', '')) }),
      /gh is not installed/,
    );
  });
});

describe('creating a pull request', () => {
  const CREATED = 'https://github.com/podman-desktop/podman-desktop/pull/2871\n';

  // The reason this check exists here at all: dispatch.js guards Bash calls the
  // agent makes and cannot see a child process this module spawns. Without
  // this, the plugin's own happy path would be the one route to GitHub with no
  // consent on it.
  test('without a token it refuses, and nothing is sent', async () => {
    await assert.rejects(
      () => createPullRequest({ head: BRANCH, title: 't', body: 'b', config: CONFIG, home, exec: fakeGh(CREATED) }),
      /refusing to open a pull request.*no consent token/s,
    );

    assert.equal(calls.length, 0, 'gh must not be invoked at all');
  });

  test('with a token it sends the right call and spends it', async () => {
    await gate.open({ issue: 6001, branch: BRANCH, home });

    const result = await createPullRequest({
      head: BRANCH,
      title: 'fix(main): guard the empty case',
      body: '### What does this PR do?\n\nGuards it.\n',
      config: CONFIG,
      home,
      exec: fakeGh(CREATED),
    });

    const [call] = calls;
    assert.deepEqual(call.args.slice(0, 4), ['pr', 'create', '--repo', 'podman-desktop/podman-desktop']);
    assert.ok(call.args.includes('--base') && call.args.includes('main'));
    assert.ok(call.args.includes('--head') && call.args.includes(`vzhukovs:${BRANCH}`));

    // The body goes in on stdin: as an argument it hits the argv limit, and
    // every quoting bug on that path publishes the wrong text.
    assert.ok(call.args.includes('--body-file') && call.args.includes('-'));
    assert.equal(call.stdin, '### What does this PR do?\n\nGuards it.\n');

    assert.equal(result.number, 2871);
    assert.equal(result.url, CREATED.trim());

    // One token, one write.
    assert.equal((await gate.verify({ branch: BRANCH, home })).valid, false);
  });

  test('an expired token refuses', async () => {
    await gate.open({ issue: 6001, branch: BRANCH, ttlMs: -1, home });

    await assert.rejects(
      () => createPullRequest({ head: BRANCH, title: 't', body: 'b', config: CONFIG, home, exec: fakeGh(CREATED) }),
      /expired/,
    );
    assert.equal(calls.length, 0);
  });

  test('a token for another branch does not open this one', async () => {
    await gate.open({ issue: 6001, branch: BRANCH, home });

    await assert.rejects(
      () => createPullRequest({ head: 'DESKTOP-6001/2-other', title: 't', body: 'b', config: CONFIG, home, exec: fakeGh(CREATED) }),
      /no consent token/,
    );
    assert.equal(calls.length, 0);
  });
});

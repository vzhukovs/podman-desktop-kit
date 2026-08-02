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

import {
  checkRunsForCommit,
  createPullRequest,
  discussion,
  fetchIssue,
  headRef,
  linkedPullRequests,
  peerCheckFailures,
  pullRequest,
  replyToThread,
  reviewThreads,
  upstreamSlug,
} from '../lib/gh.js';
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

  /** A timeline response, as the GraphQL query shapes it. */
  const timeline = (...prs) =>
    JSON.stringify({
      data: { repository: { issue: { timelineItems: { nodes: prs } } } },
    });

  // Searching for the issue number matches it anywhere in a pull request body,
  // and dependency bumps paste whole upstream changelogs. Asking GitHub what it
  // considers linked is the difference between an answer and a coincidence.
  test('linkedPullRequests asks the timeline rather than searching text', async () => {
    await linkedPullRequests(17221, { config: CONFIG, exec: fakeGh(timeline()) });

    const [call] = calls;
    assert.deepEqual(call.args.slice(0, 2), ['api', 'graphql']);
    assert.ok(call.args.some((arg) => arg.includes('CROSS_REFERENCED_EVENT')));
    assert.ok(call.args.some((arg) => arg.includes('CONNECTED_EVENT')));
    assert.ok(call.args.includes('number=17221'));

    // A query, not a mutation: the gate must not demand consent to read.
    assert.ok(!call.args.some((arg) => /\bmutation\b/.test(arg)));
  });

  test('it reads both event shapes, drops duplicates, and flags reverts', async () => {
    const prs = await linkedPullRequests(17221, {
      config: CONFIG,
      exec: fakeGh(
        timeline(
          { source: { number: 2, state: 'MERGED', title: 'Revert "fix: the thing"', url: 'u2', mergedAt: null } },
          { subject: { number: 1, state: 'MERGED', title: 'fix: the thing', url: 'u1', mergedAt: '2026-01-01T00:00:00Z' } },
          { source: { number: 2, state: 'MERGED', title: 'Revert "fix: the thing"', url: 'u2', mergedAt: null } },
          // A cross-reference from an issue rather than a pull request.
          { source: {} },
        ),
      ),
    });

    assert.equal(prs.length, 2, 'the repeated timeline entry was not collapsed');

    // A closed PR that was reverted is the signal for the redo route, and
    // looking only at open PRs would miss the case that most needs archaeology.
    assert.equal(prs[0].number, 1);
    assert.equal(prs[0].isRevert, false);
    assert.equal(prs[1].isRevert, true);
    assert.equal(prs[1].mergedAt, null);
  });

  test('a cross-reference from another repository is not a linked pull request', async () => {
    // Live on #18381: yuvalgalanti/AppDev-UX-Prototypes#17, merged, showed up
    // as `linked: #17 MERGED` — which triage reads as "this was already done".
    // The timeline is still the authority on what references the issue; it is
    // just not an authority on where the reference lives.
    const prs = await linkedPullRequests(18381, {
      config: CONFIG,
      exec: fakeGh(
        timeline(
          {
            source: {
              number: 17,
              state: 'MERGED',
              title: 'feat(podman-desktop): add Enterprise Support Page prototype',
              url: 'https://github.com/yuvalgalanti/AppDev-UX-Prototypes/pull/17',
              mergedAt: '2026-07-21T09:46:49Z',
              repository: { nameWithOwner: 'yuvalgalanti/AppDev-UX-Prototypes' },
            },
          },
          {
            source: {
              number: 18546,
              state: 'OPEN',
              title: 'fix: the thing',
              url: 'https://github.com/podman-desktop/podman-desktop/pull/18546',
              mergedAt: null,
              repository: { nameWithOwner: 'podman-desktop/podman-desktop' },
            },
          },
        ),
      ),
    });

    assert.deepEqual(
      prs.map((pr) => pr.number),
      [18546],
    );
  });

  test('an issue nothing references gives an empty list, not an error', async () => {
    assert.deepEqual(await linkedPullRequests(1, { config: CONFIG, exec: fakeGh(timeline()) }), []);
    assert.deepEqual(
      await linkedPullRequests(1, { config: CONFIG, exec: fakeGh(JSON.stringify({ data: { repository: { issue: null } } })) }),
      [],
    );
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

describe('reading a pull request', () => {
  /** A rollup entry as `pr view --json statusCheckRollup` returns it. */
  const checkRun = (name, conclusion) => ({
    name,
    status: 'COMPLETED',
    conclusion,
    workflowName: 'pr-check',
    detailsUrl: `https://example/${name}`,
  });

  test('the CI rollup is flattened, statuses and check runs alike', async () => {
    const pr = await pullRequest(17577, {
      config: CONFIG,
      exec: fakeGh(
        JSON.stringify({
          number: 17577,
          author: { login: 'vzhukovs' },
          statusCheckRollup: [
            checkRun('Windows', 'FAILURE'),
            // A third-party status spells its outcome differently, and code
            // downstream must not have to know which kind it is looking at.
            { context: 'codecov/patch', state: 'FAILURE', targetUrl: 'https://codecov' },
          ],
        }),
      ),
    });

    assert.equal(pr.author, 'vzhukovs', 'the author is flattened out of its object');
    assert.deepEqual(
      pr.checks.map((check) => [check.name, check.status, check.conclusion]),
      [
        ['Windows', 'COMPLETED', 'FAILURE'],
        ['codecov/patch', 'COMPLETED', 'FAILURE'],
      ],
    );
  });

  // Why peers rather than the base branch, in one assertion: podman-desktop
  // runs pr-check on pull_request, so main never runs these jobs. Measuring
  // against the base would report every red as inconclusive.
  test('peerCheckFailures counts how many other PRs the same job is red on', async () => {
    const { sampled, red } = await peerCheckFailures({
      exclude: 17577,
      config: CONFIG,
      exec: fakeGh(
        JSON.stringify([
          { number: 17577, author: null, statusCheckRollup: [checkRun('Windows', 'FAILURE')] },
          { number: 18550, author: null, statusCheckRollup: [checkRun('Windows', 'FAILURE')] },
          { number: 18486, author: null, statusCheckRollup: [checkRun('Windows', 'FAILURE'), checkRun('Linux', 'SUCCESS')] },
        ]),
      ),
    });

    assert.equal(sampled, 2, 'our own PR must not be part of its own baseline');
    assert.deepEqual(red.get('Windows'), [18550, 18486]);
    assert.equal(red.has('Linux'), false, 'a green job has no business in the failure map');
  });

  test('every run against a commit is read, not just the latest', async () => {
    const runs = await checkRunsForCommit('8374334', {
      config: CONFIG,
      exec: fakeGh(
        JSON.stringify({
          check_runs: [
            { name: 'Windows', conclusion: 'failure', started_at: '2026-06-01T00:00:00Z' },
            { name: 'Windows', conclusion: 'success', started_at: '2026-06-02T00:00:00Z' },
          ],
        }),
      ),
    });

    // The same job, the same commit, two answers. `pr view` reports only the
    // last one, which is how a re-run erases the evidence of a flake.
    assert.deepEqual(
      runs.map((run) => run.conclusion),
      ['FAILURE', 'SUCCESS'],
    );
  });

  const threadPage = (nodes, hasNextPage = false, endCursor = null) =>
    JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
    });

  const thread = (id, author, extra = {}) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: 'packages/main/src/plugin/handler.ts',
    line: 222,
    comments: { nodes: [{ author: { login: author }, body: `${author} says`, createdAt: '2026-05-20T12:05:18Z', url: `u/${id}` }] },
    ...extra,
  });

  test('threads come from GraphQL, because REST cannot say what is resolved', async () => {
    await reviewThreads(17577, { config: CONFIG, exec: fakeGh(threadPage([])) });

    const [call] = calls;
    assert.deepEqual(call.args.slice(0, 2), ['api', 'graphql']);
    assert.ok(call.args.some((arg) => arg.includes('isResolved')));
    assert.ok(call.args.includes('number=17577'));
    assert.ok(!call.args.some((arg) => /\bmutation\b/.test(arg)), 'reading must not need consent');
  });

  test('pagination is followed', async () => {
    let page = 0;
    const exec = (file, args, options, callback) => {
      calls.push({ file, args, options, stdin: null });
      const body = page++ === 0 ? threadPage([thread('t1', 'coderabbitai')], true, 'CURSOR') : threadPage([thread('t2', 'jiridostal')]);
      queueMicrotask(() => callback(null, body, ''));
      return { stdin: { end: () => {} } };
    };

    const threads = await reviewThreads(17577, { config: CONFIG, exec });

    // A long-running PR with a chatty bot passes fifty threads, and the ones
    // that fall off the first page are the ones that have waited longest.
    assert.equal(threads.length, 2);
    assert.ok(calls[1].args.includes('cursor=CURSOR'));
    assert.deepEqual(
      threads.map((entry) => entry.author),
      ['coderabbitai', 'jiridostal'],
    );
  });

  // Straight from PR #17577: both open threads are the bot's, and the reason
  // the PR is blocked is a review body plus a top-level comment. Reading only
  // threads would report two bot findings and no human ones.
  /** The GraphQL shape `discussion` reads, with the author types GitHub reports. */
  const discussionPage = () =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                { author: { login: 'coderabbitai', __typename: 'Bot' }, state: 'COMMENTED', body: '', submittedAt: '2026-05-20T12:05:19Z' },
                { author: { login: 'vancura', __typename: 'User' }, state: 'APPROVED', body: '', submittedAt: '2026-05-21T10:38:58Z' },
                {
                  author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' },
                  state: 'COMMENTED',
                  body: 'Copilot was unable to review this pull request.',
                  submittedAt: '2026-06-01T00:00:00Z',
                },
                { author: { login: 'benoitf', __typename: 'User' }, state: 'CHANGES_REQUESTED', body: 'please split this', submittedAt: '2026-06-05T05:58:37Z' },
              ],
            },
            comments: { nodes: [{ author: { login: 'jiridostal', __typename: 'User' }, body: 'any update?', createdAt: '2026-06-02T09:06:38Z' }] },
          },
        },
      },
    });

  test('review submissions and top-level comments are read too', async () => {
    const { reviews, comments } = await discussion(17577, { config: CONFIG, exec: fakeGh(discussionPage()) });

    // The empty COMMENTED review is the wrapper around inline threads and says
    // nothing; the empty APPROVED one says everything it needs to in its state.
    assert.deepEqual(
      reviews.map((review) => `${review.author}:${review.state}`),
      ['vancura:APPROVED', 'copilot-pull-request-reviewer:COMMENTED', 'benoitf:CHANGES_REQUESTED'],
    );
    assert.deepEqual(comments.map((comment) => comment.author), ['jiridostal']);
  });

  // The reason this call moved to GraphQL. `gh pr view --json reviews` answers
  // `{"login": "copilot-pull-request-reviewer"}` — no `[bot]` suffix, no type —
  // so on PR #18556 a review from an app was counted as the only human on it.
  test('the account type comes back, so a bot nobody listed is still a bot', async () => {
    const { reviews, comments } = await discussion(17577, { config: CONFIG, exec: fakeGh(discussionPage()) });

    const byLogin = Object.fromEntries(reviews.map((review) => [review.author, review.isBotAccount]));
    assert.equal(byLogin['copilot-pull-request-reviewer'], true, 'not in bots_collapsed, and still recognised');
    assert.equal(byLogin.vancura, false);
    assert.equal(byLogin.benoitf, false);
    assert.equal(comments[0].isBotAccount, false);
  });

  test('it asks GraphQL for the type, and asks once', async () => {
    await discussion(17577, { config: CONFIG, exec: fakeGh(discussionPage()) });

    assert.equal(calls.length, 1, 'reviews and comments must describe the same moment');
    assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'graphql']);
    assert.ok(
      calls[0].args.some((arg) => arg.includes('__typename')),
      'without it GitHub reports every app account as a plain login',
    );
  });

  test('a resolved thread is still reported, and replies are counted', async () => {
    const threads = await reviewThreads(17577, {
      config: CONFIG,
      exec: fakeGh(
        threadPage([
          thread('t1', 'jiridostal', {
            isResolved: true,
            comments: {
              nodes: [
                { author: { login: 'jiridostal' }, body: 'ask', createdAt: '2026-06-02T09:06:38Z', url: 'u1' },
                { author: { login: 'vzhukovs' }, body: 'answer', createdAt: '2026-06-03T09:06:38Z', url: 'u2' },
              ],
            },
          }),
        ]),
      ),
    });

    // Resolved is not the same as irrelevant: someone resolving a thread since
    // the last sync is the difference between waiting and moving on.
    assert.equal(threads[0].isResolved, true);
    assert.equal(threads[0].replies, 1);
    assert.equal(threads[0].body, 'ask', 'the first comment is the ask; later ones are the conversation');
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

describe('replying to a review thread', () => {
  const REPLIED = JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: 'https://example/c1' } } } });

  before(async () => {
    // A pull request has to exist before there is anything to reply on.
    await transition(6001, 'pr-open', { home });
  });

  test('without a reply token it refuses, and nothing is sent', async () => {
    await assert.rejects(
      () => replyToThread({ pr: 17577, threadId: 't1', body: 'done', home, exec: fakeGh(REPLIED) }),
      /refusing to reply on #17577.*no consent token/s,
    );

    assert.equal(calls.length, 0);
  });

  test('a push token is not consent to reply', async () => {
    // The issue is in pr-open, so no push token can even be issued; what is
    // being asserted is that the two keys cannot be found for one another.
    await gate.open({ issue: 6001, pr: 17578, kind: 'reply', home });

    await assert.rejects(() => replyToThread({ pr: 17577, threadId: 't1', body: 'done', home, exec: fakeGh(REPLIED) }), /no consent token/);
  });

  test('with a token the reply is sent, and resolving is a second call after it', async () => {
    await gate.open({ issue: 6001, pr: 17577, kind: 'reply', home });

    const result = await replyToThread({
      pr: 17577,
      threadId: 'PRRT_kwDO',
      body: 'Fixed in 8374334.',
      resolve: true,
      home,
      exec: (file, args, options, callback) => {
        calls.push({ file, args, options, stdin: null });
        const body = args.some((arg) => arg.includes('resolveReviewThread'))
          ? JSON.stringify({ data: { resolveReviewThread: { thread: { id: 't', isResolved: true } } } })
          : REPLIED;
        queueMicrotask(() => callback(null, body, ''));
        return { stdin: { end: () => {} } };
      },
    });

    assert.equal(result.url, 'https://example/c1');
    assert.equal(result.resolved, true);

    // Reply first, resolve second: a thread resolved before the answer lands is
    // a thread the reviewer sees closed with nothing in it.
    assert.ok(calls[0].args.some((arg) => arg.includes('addPullRequestReviewThreadReply')));
    assert.ok(calls[0].args.includes('body=Fixed in 8374334.'));
    assert.ok(calls[1].args.some((arg) => arg.includes('resolveReviewThread')));
  });

  // Eight drafted replies read in one go are one act of consent. Spending on
  // the first would refuse the other seven the human just approved.
  test('the token covers the whole batch rather than one thread', async () => {
    await gate.open({ issue: 6001, pr: 17577, kind: 'reply', home });

    for (const threadId of ['t1', 't2', 't3']) {
      await replyToThread({ pr: 17577, threadId, body: 'ok', home, exec: fakeGh(REPLIED) });
    }

    assert.equal(calls.length, 3);
  });
});

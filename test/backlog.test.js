// SPDX-License-Identifier: Apache-2.0

// Tests for lib/backlog.js.
//
// Every fixture in this file is the shape of something the live upstream
// backlog actually returned on 2026-08-01, because each of the three ways this
// listing can lie was found there rather than imagined:
//
//   - #18381 is cross-referenced by a merged pull request in a stranger's
//     repository, which read as "already implemented" until the repository was
//     compared;
//   - #13748 was last touched by the stale bot, so `updatedAt` said today while
//     the last human word was five months old;
//   - #18381 again: its reporter is a MEMBER commenting on their own issue,
//     which read as "a maintainer answered" until the author was excluded.
//
// All three share one property: nothing looks broken. The listing stays
// readable, plausible and wrong, and the only thing standing between it and a
// day spent on an issue somebody else is already doing is these assertions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { collect, describe as describeIssue, format, order, sections } from '../lib/backlog.js';

const CONFIG = {
  repo: { upstream: 'podman-desktop/podman-desktop' },
  review: { bots_collapsed: ['coderabbitai'] },
};

/** Fixed "now", so idle days are arithmetic rather than weather. */
const NOW = Date.parse('2026-08-01T00:00:00Z');

const BUG_BODY = [
  '### Bug description',
  '',
  'The terminal throws on resize.',
  '',
  '### Operating system',
  '',
  'macOS 15',
  '',
  '### Steps to reproduce',
  '',
  '1. Open a container terminal',
  '2. Resize the window',
  '',
].join('\n');

const BUG_WITHOUT_STEPS = BUG_BODY.replace('1. Open a container terminal\n2. Resize the window', '_No response_');

/**
 * @param {object} [overrides]
 * @returns {object} one node in the shape gh.openIssues returns
 */
function issue(overrides = {}) {
  return {
    number: 18553,
    title: 'TypeError accessing container.id on window resize',
    url: 'https://github.com/podman-desktop/podman-desktop/issues/18553',
    body: BUG_BODY,
    state: 'OPEN',
    author: 'reporter',
    createdAt: '2026-07-31T00:00:00Z',
    updatedAt: '2026-07-31T00:00:00Z',
    labels: ['area/terminal'],
    assignees: [],
    comments: { total: 0, recent: [] },
    pulls: [],
    ...overrides,
  };
}

const facts = (overrides = {}) => describeIssue(issue(overrides), { config: CONFIG, now: NOW });

describe('the body says what the reporter answered', () => {
  test('sections are split on their headings', () => {
    const parts = sections(BUG_BODY);

    assert.equal(parts.get('bug description'), 'The terminal throws on resize.');
    assert.equal(parts.get('steps to reproduce'), '1. Open a container terminal\n2. Resize the window');
  });

  test('a bug with steps carries a reproduction', () => {
    const candidate = facts();

    assert.equal(candidate.template, 'bug');
    assert.equal(candidate.reproduction, 'steps');
    assert.ok(candidate.signals.includes('reproduction'));
  });

  test('_No response_ is an empty section, not an answer', () => {
    // The heading is present either way. Counting it would report a
    // reproduction on every bug filed through the template, including the ones
    // whose reproduction field the reporter left blank.
    const candidate = facts({ body: BUG_WITHOUT_STEPS });

    assert.equal(candidate.reproduction, 'missing');
    assert.ok(!candidate.signals.includes('reproduction'));
  });

  test('a feature request is not missing a reproduction, it has no place for one', () => {
    const body = ["### Describe the solution you'd like", '', 'A registry browser.', ''].join('\n');
    const candidate = facts({ body });

    assert.equal(candidate.template, 'feature');
    assert.equal(candidate.reproduction, 'n/a');
  });

  test('a free-hand body follows no template and says so', () => {
    const candidate = facts({ body: 'paste does not work in the terminal' });

    assert.equal(candidate.template, null);
    assert.deepEqual(candidate.signals, []);
  });
});

describe('who answered, and whether anyone did', () => {
  test('a maintainer reply is a signal', () => {
    const candidate = facts({
      comments: {
        total: 1,
        recent: [{ author: 'benoitf', isBotAccount: false, association: 'MEMBER', at: '2026-07-31T12:00:00Z' }],
      },
    });

    assert.deepEqual(candidate.maintainer, { login: 'benoitf', at: '2026-07-31T12:00:00Z' });
    assert.ok(candidate.signals.includes('maintainer-replied'));
  });

  test('the reporter is not the project answering, even when they are a member', () => {
    // Live on #18381: author kyetter is a MEMBER and the only commenter. Their
    // own follow-up would otherwise read as the project having weighed in.
    const candidate = facts({
      author: 'kyetter',
      comments: {
        total: 1,
        recent: [{ author: 'kyetter', isBotAccount: false, association: 'MEMBER', at: '2026-07-31T20:24:25Z' }],
      },
    });

    assert.equal(candidate.maintainer, null);
    assert.ok(!candidate.signals.includes('maintainer-replied'));
  });

  test('a contributor answering is not a maintainer answering', () => {
    const candidate = facts({
      comments: {
        total: 1,
        recent: [{ author: 'passer-by', isBotAccount: false, association: 'CONTRIBUTOR', at: '2026-07-31T12:00:00Z' }],
      },
    });

    assert.equal(candidate.maintainer, null);
  });

  test('a bot is not a human, whichever way GitHub spells its login', () => {
    // GraphQL returns the stale bot as `github-actions`, with no [bot] suffix
    // for threads.isBot to match on, so the account type has to carry it.
    const candidate = facts({
      comments: {
        total: 2,
        recent: [
          { author: 'github-actions', isBotAccount: true, association: 'CONTRIBUTOR', at: '2026-08-01T00:52:54Z' },
          { author: 'coderabbitai', isBotAccount: false, association: 'NONE', at: '2026-08-01T00:53:00Z' },
        ],
      },
    });

    assert.equal(candidate.comments.recentHuman, 0);
    assert.equal(candidate.maintainer, null);
  });
});

describe('activity is what a human did, not what the timestamp moved for', () => {
  test('a stale-bot notice does not make an abandoned issue fresh', () => {
    // #13748: updatedAt was today, the last human comment was 2026-02-02.
    const candidate = facts({
      number: 13748,
      createdAt: '2025-08-28T20:08:00Z',
      updatedAt: '2026-08-01T00:52:55Z',
      comments: {
        total: 4,
        recent: [
          { author: 'rujutashinde', isBotAccount: false, association: 'MEMBER', at: '2026-02-02T00:12:34Z' },
          { author: 'github-actions', isBotAccount: true, association: 'CONTRIBUTOR', at: '2026-08-01T00:52:54Z' },
        ],
      },
    });

    assert.equal(candidate.lastHumanActivity, '2026-02-02T00:12:34.000Z');
    assert.equal(candidate.idleDays, 179);
  });

  test('an issue nobody has commented on is idle since it was filed', () => {
    const candidate = facts({ createdAt: '2026-07-25T00:00:00Z', comments: { total: 0, recent: [] } });

    assert.equal(candidate.idleDays, 7);
    assert.equal(candidate.ageDays, 7);
  });
});

describe('what stops a start', () => {
  test('an open pull request is a blocker, with its number', () => {
    const candidate = facts({
      pulls: [{ number: 18546, state: 'OPEN', title: 'fix: path label', mergedAt: null, isRevert: false }],
    });

    assert.deepEqual(candidate.blockers, [{ kind: 'open-pr', detail: '#18546' }]);
  });

  test('an assignee is a blocker naming who', () => {
    const candidate = facts({ assignees: ['cdrage'] });

    assert.deepEqual(candidate.blockers, [{ kind: 'assigned', detail: 'cdrage' }]);
  });

  test('a merged pull request plus a revert is the redo route', () => {
    const candidate = facts({
      pulls: [
        { number: 100, state: 'MERGED', title: 'feat: the thing', mergedAt: '2026-06-01T00:00:00Z', isRevert: false },
        { number: 120, state: 'MERGED', title: 'Revert "feat: the thing"', mergedAt: '2026-06-09T00:00:00Z', isRevert: true },
      ],
    });

    assert.ok(candidate.history.includes('reverted'));
    // Neither of them is open, so neither of them stops the work.
    assert.deepEqual(candidate.blockers, []);
  });

  test('a closed pull request that never merged is an attempt somebody rejected', () => {
    const candidate = facts({
      pulls: [{ number: 90, state: 'CLOSED', title: 'fix: the thing', mergedAt: null, isRevert: false }],
    });

    assert.deepEqual(candidate.history, ['closed-attempt']);
  });
});

describe('the order', () => {
  const candidate = (number, signals, blockers, idleDays) => ({
    number,
    signals,
    blockers,
    idleDays,
  });

  test('what cannot be started sinks, however good it looks', () => {
    const ordered = order([
      candidate(1, ['reproduction', 'maintainer-replied', 'template'], [{ kind: 'open-pr', detail: '#2' }], 0),
      candidate(2, [], [], 40),
    ]);

    assert.deepEqual(
      ordered.map((entry) => entry.number),
      [2, 1],
    );
  });

  test('more signals first, then least idle', () => {
    const ordered = order([
      candidate(1, ['template'], [], 1),
      candidate(2, ['reproduction', 'template'], [], 30),
      candidate(3, ['template'], [], 0),
    ]);

    assert.deepEqual(
      ordered.map((entry) => entry.number),
      [2, 3, 1],
    );
  });

  test('ties break on the issue number, so two runs print the same list', () => {
    const twice = () => order([candidate(7, [], [], 3), candidate(9, [], [], 3), candidate(8, [], [], 3)]);

    assert.deepEqual(
      twice().map((entry) => entry.number),
      [9, 8, 7],
    );
    assert.deepEqual(twice(), twice());
  });
});

describe('collect', () => {
  /** A stand-in for execFile that answers with one canned GraphQL page. */
  function fakeGh(nodes, calls = []) {
    return (file, args, options, callback) => {
      calls.push({ file, args });
      queueMicrotask(() => callback(null, JSON.stringify({ data: { repository: { issues: { nodes } } } }), ''));
      return { stdin: { end: () => {} } };
    };
  }

  /** The raw GraphQL node shape, which is not the shape describe() takes. */
  const node = (overrides = {}) => ({
    number: 18553,
    title: 'TypeError on resize',
    url: 'https://github.com/podman-desktop/podman-desktop/issues/18553',
    body: BUG_BODY,
    state: 'OPEN',
    createdAt: '2026-07-31T00:00:00Z',
    updatedAt: '2026-07-31T00:00:00Z',
    author: { login: 'reporter' },
    assignees: { nodes: [] },
    labels: { nodes: [{ name: 'area/terminal' }] },
    comments: { totalCount: 0, nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  });

  test('one request for the whole batch, naming upstream and the filter', async () => {
    const calls = [];
    const report = await collect({
      config: CONFIG,
      labels: ['area/terminal', 'kind/bug'],
      limit: 5,
      now: NOW,
      exec: fakeGh([node()], calls),
    });

    assert.equal(calls.length, 1, 'one call, not one per issue');
    assert.ok(calls[0].args.includes('-F'));
    assert.ok(calls[0].args.includes('owner=podman-desktop'));
    assert.ok(calls[0].args.includes('name=podman-desktop'));
    assert.ok(calls[0].args.includes('limit=5'));
    assert.ok(calls[0].args.includes('labels[]=area/terminal'));
    assert.ok(calls[0].args.includes('labels[]=kind/bug'));

    assert.equal(report.scanned, 1);
    assert.equal(report.available, 1);
    assert.equal(report.candidates[0].number, 18553);
  });

  test('a cross-reference from someone else‘s repository is not a linked pull request', async () => {
    // #18381, live: yuvalgalanti/AppDev-UX-Prototypes#17 is merged, and it says
    // nothing whatever about whether podman-desktop has this work.
    const report = await collect({
      config: CONFIG,
      now: NOW,
      exec: fakeGh([
        node({
          number: 18381,
          timelineItems: {
            nodes: [
              {
                source: {
                  number: 17,
                  title: 'feat(podman-desktop): add Enterprise Support Page prototype',
                  state: 'MERGED',
                  url: 'https://github.com/yuvalgalanti/AppDev-UX-Prototypes/pull/17',
                  mergedAt: '2026-07-21T09:46:49Z',
                  repository: { nameWithOwner: 'yuvalgalanti/AppDev-UX-Prototypes' },
                },
              },
              { source: {} },
            ],
          },
        }),
      ]),
    });

    assert.deepEqual(report.candidates[0].pulls, []);
    assert.deepEqual(report.candidates[0].history, []);
    assert.deepEqual(report.candidates[0].blockers, []);
  });

  test('a pull request in this repository still counts', async () => {
    const report = await collect({
      config: CONFIG,
      now: NOW,
      exec: fakeGh([
        node({
          timelineItems: {
            nodes: [
              {
                source: {
                  number: 18546,
                  title: 'fix: the thing',
                  state: 'OPEN',
                  url: 'https://github.com/podman-desktop/podman-desktop/pull/18546',
                  mergedAt: null,
                  repository: { nameWithOwner: 'podman-desktop/podman-desktop' },
                },
              },
            ],
          },
        }),
      ]),
    });

    assert.deepEqual(report.candidates[0].blockers, [{ kind: 'open-pr', detail: '#18546' }]);
    assert.equal(report.available, 0);
  });

  test('an empty backlog is an answer, not an error', async () => {
    const report = await collect({ config: CONFIG, now: NOW, exec: fakeGh([]) });

    assert.equal(report.scanned, 0);
    assert.match(format(report), /Nothing came back/);
  });
});

describe('the listing reports and does not pick', () => {
  test('no candidate carries a score', async () => {
    const candidate = facts();

    // A number here would read as measured. The thing that decides — whether
    // the requirement is clear enough to plan — is not in this module.
    assert.ok(!('score' in candidate));
    assert.ok(!('recommended' in candidate));
    assert.ok(!('verdict' in candidate));
  });

  test('and the module cannot move an issue', async () => {
    const source = await (await import('node:fs/promises')).readFile(new URL('../lib/backlog.js', import.meta.url), 'utf8');

    // Listing what is available is a read. A listing that triaged what it
    // listed would be a listing that picked.
    assert.ok(!/from '\.\/state\.js'/.test(source));
  });
});

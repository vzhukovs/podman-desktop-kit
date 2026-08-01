// SPDX-License-Identifier: Apache-2.0

// Tests for lib/review.js.
//
// Two properties are load-bearing.
//
// The first is what is NOT reported. Commit scope is our own discipline and not
// upstream's rule, and a review that spends an author's attention on a rule
// their project does not have loses the standing to raise the ones it does. It
// is asserted here because it is an omission, and omissions are what get
// helpfully "fixed" later.
//
// The second is that the diff is real. Someone else's pull request is read by
// fetching refs/pull/<k>/head and diffing against the merge base — against the
// base branch tip it would carry every commit that landed since, and the review
// would ask the author about work they never did.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanup, commitAll, git, initRepo, packageMap, seedWorkspace, writeFiles } from './helpers/repo-fixture.js';
import * as review from '../lib/review.js';

const PR = 2903;

const CONFIG = {
  repo: { upstream: 'podman-desktop/podman-desktop', fork: 'vzhukovs/podman-desktop', base_branch: 'main', upstream_remote: 'upstream' },
  slicing: { layer_order: ['extension-api', 'main', 'ui', 'tests'] },
  review: { bots_collapsed: ['coderabbitai', 'codecov'], bot_escalate: ['security'] },
};

let upstream;
let clone;
let home;
/** Every call the fake gh received. */
let calls;

/**
 * A stand-in for execFile that answers each `gh` call from a queue.
 *
 * @param {string[]} responses
 */
function fakeGh(responses) {
  const queue = [...responses];
  return (file, args, options, callback) => {
    calls.push({ file, args });
    const stdout = queue.shift() ?? '{}';
    queueMicrotask(() => callback(null, stdout, ''));
    return { stdin: { end: () => {} } };
  };
}

/** What `gh pr view --json` returns for the pull request under review. */
const PULL = JSON.stringify({
  number: PR,
  title: 'feat(main): add a thing',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'someone-else' },
  url: `https://github.com/podman-desktop/podman-desktop/pull/${PR}`,
  additions: 42,
  deletions: 3,
  changedFiles: 3,
  reviewDecision: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
  headRefName: 'their-branch',
  baseRefName: 'main',
  headRefOid: 'deadbeef',
  body: 'Closes #17221\n\nAnd part of #17000.',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
});

const THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'T_1',
              isResolved: false,
              path: 'packages/main/src/exec.ts',
              line: 12,
              comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'Consider extracting this.', createdAt: '2026-07-02T00:00:00Z' }] },
            },
            {
              id: 'T_2',
              isResolved: false,
              path: 'packages/main/src/exec.ts',
              line: 20,
              comments: { nodes: [{ author: { login: 'jiridostal' }, body: 'This changes behaviour on Windows.', createdAt: '2026-07-03T00:00:00Z' }] },
            },
          ],
        },
      },
    },
  },
});

const DISCUSSION = JSON.stringify({ reviews: [], comments: [] });

before(async () => {
  upstream = await initRepo('pdkit-review-upstream-');
  home = await initRepo('pdkit-review-home-');

  await seedWorkspace(upstream);
  await commitAll(upstream, 'chore: seed');

  // Their branch: two layers, a new file without a licence header, and a
  // schema changed with nothing generated alongside it.
  await git(['checkout', '-q', '-b', 'their-branch'], upstream);
  await writeFiles(upstream, {
    'packages/extension-api/src/api.ts':
      '// SPDX-License-Identifier: Apache-2.0\nexport const version = 1;\nexport interface RunOptions { env?: string }\n',
    'packages/main/src/added.ts': 'export function added() {}\n',
    'packages/main/src/settings.schema.json': '{"type":"object"}\n',
  });
  await commitAll(upstream, 'feat(main): add a thing');
  const head = await git(['rev-parse', 'HEAD'], upstream);
  await git(['update-ref', `refs/pull/${PR}/head`, head], upstream);

  // Upstream moves on after the pull request was opened. Diffing against the
  // tip would attribute this commit to the author.
  await git(['checkout', '-q', 'main'], upstream);
  await writeFiles(upstream, { 'packages/ui/src/unrelated.ts': '// SPDX-License-Identifier: Apache-2.0\nexport const later = 1;\n' });
  await commitAll(upstream, 'chore: something else entirely');

  clone = await initRepo('pdkit-review-clone-');
  await git(['remote', 'add', 'upstream', upstream], clone);
  await git(['fetch', '-q', 'upstream', 'main'], clone);
  await git(['reset', '-q', '--hard', 'upstream/main'], clone);

  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'package-map.json'), JSON.stringify(packageMap(clone), null, 2));
});

after(async () => {
  await cleanup(upstream, clone, home);
});

/** @param {object} [overrides] */
function collect(overrides = {}) {
  calls = [];
  return review.collect({
    pr: PR,
    repoRoot: clone,
    config: CONFIG,
    home,
    exec: fakeGh([PULL, THREADS, DISCUSSION]),
    ...overrides,
  });
}

describe('the diff', () => {
  test('comes from where the pull request branched, not from where upstream is now', async () => {
    const report = await collect();

    const paths = report.diff.files.map((entry) => entry.path).sort();
    assert.deepEqual(paths, [
      'packages/extension-api/src/api.ts',
      'packages/main/src/added.ts',
      'packages/main/src/settings.schema.json',
    ]);
    assert.equal(
      paths.includes('packages/ui/src/unrelated.ts'),
      false,
      'the commit upstream made after the PR was opened is not the author\'s to answer for',
    );
  });

  test('the pull request is read from upstream, explicitly', async () => {
    await collect();

    const [view] = calls;
    assert.deepEqual(view.args.slice(0, 5), ['pr', 'view', String(PR), '--repo', 'podman-desktop/podman-desktop']);
  });
});

describe('the mechanical half', () => {
  test('files are grouped by layer, in merge order', async () => {
    const report = await collect();

    assert.deepEqual(report.layers.map((entry) => entry.layer), ['extension-api', 'main']);
    assert.equal(report.layers[0].files.length, 1);
    assert.equal(report.layers[1].files.length, 2);
  });

  test('a touched public API is called out, and so is a symbol that reaches it', async () => {
    const report = await collect();

    assert.equal(report.api.touched, false, 'this PR does not edit extension-api.d.ts itself');
    const runOptions = report.api.symbols.find((entry) => entry.symbol === 'RunOptions');
    assert.ok(runOptions, 'the exported symbol added by the diff is picked up');
  });

  test('a schema changed with nothing generated beside it is reported', async () => {
    const report = await collect();

    assert.deepEqual(report.schemas.touched, ['packages/main/src/settings.schema.json']);
    assert.deepEqual(report.schemas.generated, []);
  });

  test('an added file with no licence header is reported', async () => {
    const report = await collect();

    assert.deepEqual(report.missingSpdx, ['packages/main/src/added.ts']);
  });

  test('the issues the pull request says it closes are read from its body', async () => {
    const report = await collect();

    assert.deepEqual(report.references, [17221, 17000]);
  });

  test('commit scope is never reported: upstream does not require it', async () => {
    const report = await collect();
    const text = review.format(report);

    assert.equal(/scope/i.test(text), false, 'scope is our discipline, not the author\'s rule');
    assert.equal(/scope/i.test(JSON.stringify(report)), false);
  });
});

describe('what reviewers already said', () => {
  test('bots are folded to a line and humans are not', async () => {
    const report = await collect();

    const [bot, human] = report.feedback.threads;
    assert.equal(bot.isBot, true);
    assert.equal(bot.collapsed, true);
    assert.equal(human.isBot, false);
    assert.equal(human.collapsed, false);
    assert.equal(report.feedback.counts.human, 1);
    assert.equal(report.feedback.counts.bot, 1);
  });

  test('a bot raising something serious is expanded rather than folded', async () => {
    const escalating = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'T_9',
                  isResolved: false,
                  path: 'packages/main/src/added.ts',
                  line: 1,
                  comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'Possible security issue: the token is logged.', createdAt: '2026-07-04T00:00:00Z' }] },
                },
              ],
            },
          },
        },
      },
    });

    const report = await collect({ exec: fakeGh([PULL, escalating, DISCUSSION]) });

    assert.equal(report.feedback.threads[0].collapsed, false);
    assert.deepEqual(report.feedback.threads[0].escalated, ['security']);
  });

  test('a pull request whose threads cannot be read still produces the rest of the facts', async () => {
    const failing = (file, args, options, callback) => {
      calls.push({ file, args });
      const stdout = calls.length === 1 ? PULL : '';
      queueMicrotask(() => (calls.length === 1 ? callback(null, stdout, '') : callback(new Error('no GraphQL scope'), '', '')));
      return { stdin: { end: () => {} } };
    };

    const report = await collect({ exec: failing });

    assert.equal(report.feedback, null);
    assert.equal(report.diff.files.length, 3, 'the diff is local and does not depend on GraphQL');
  });
});

describe('the report', () => {
  test('format states plainly that it is facts and not a review', async () => {
    const text = review.format(await collect());

    assert.match(text, /These are facts, not a review/);
    assert.match(text, /more than one layer means more than one reviewer/);
  });

  test('the review lands in reviews/, not under any issue, and keeps its mandatory section', async () => {
    const written = await review.render({
      pr: PR,
      home,
      values: {
        title: 'feat(main): add a thing',
        verdict: 'APPROVE_WITH_NITS',
        confidence: 'medium — Windows behaviour was not exercised',
        requirement: 'R1',
        covered: 'yes',
        where: 'packages/main/src/added.ts:1',
        blocking: '_None._',
        shouldFix: '- The new file has no SPDX header.',
        nits: '_None._',
        questions: '- Is the schema change intentional without regenerating?',
        couldNotVerify: '- Windows behaviour: no Windows machine here.',
      },
    });

    assert.equal(written.path, join(home, 'reviews', `${PR}.md`));

    const document = await readFile(written.path, 'utf8');
    assert.match(document, /# Review: PR #2903/);
    assert.match(document, /## What I could not verify/);
    assert.match(document, /no Windows machine here/);
    assert.equal(/\{\{/.test(document), false, 'every placeholder is filled: render.js throws otherwise');
  });
});

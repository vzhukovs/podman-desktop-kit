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
 * A stand-in for execFile that answers each `gh` call by what it asked for.
 *
 * Deliberately not a positional queue any more. How many times `collect` calls
 * gh depends on how many issues the pull request references, and a queue makes
 * that count part of the fixture. Worse, a queue answers whatever was asked
 * with whatever is next: `body` was missing from the fields the real `pr view`
 * requests, and every test here passed anyway, because the fixture handed over
 * a body nobody had asked for.
 *
 * @param {{pull?: string, threads?: string, discussion?: string, issue?: (number: string) => string}} [responses]
 */
function fakeGh(responses = {}) {
  const answer = (args) => {
    const kind = args.slice(0, 2).join(' ');

    // Two different `pr view` calls: the pull request itself, and the reviews
    // and comments that are not in a thread. They differ by --json alone.
    if (kind === 'pr view') {
      return args.includes('reviews,comments') ? (responses.discussion ?? DISCUSSION) : (responses.pull ?? PULL);
    }
    if (kind === 'issue view') return (responses.issue ?? ISSUE)(args[2]);
    if (kind === 'api graphql') return responses.threads ?? THREADS;
    return '{}';
  };

  return (file, args, options, callback) => {
    calls.push({ file, args });
    const stdout = answer(args);
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

/** What `gh issue view --json` returns for an issue the pull request names. */
const ISSUE = (number) =>
  JSON.stringify({
    number: Number(number),
    title: `the issue behind #${PR}`,
    state: 'OPEN',
    url: `https://github.com/podman-desktop/podman-desktop/issues/${number}`,
    body: 'Users cannot do the thing.',
  });

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
    exec: fakeGh(),
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

  // The regression this whole group exists for. `body` was never among the
  // fields `pr view --json` was asked for, so `pull.body` was always undefined
  // and every pull request came back referencing nothing. It threw nothing and
  // logged nothing; the old fixture answered by position and handed over a body
  // regardless of what had been requested, so the tests agreed.
  test('the body is actually among the fields requested, not merely parsed', async () => {
    await collect();

    const [view] = calls;
    const fields = view.args[view.args.indexOf('--json') + 1].split(',');
    assert.ok(fields.includes('body'), 'a body that is never fetched cannot name an issue');
    assert.ok(fields.includes('closingIssuesReferences'), 'what GitHub will actually close is authoritative');
  });

  test('what GitHub will close is taken over what the body claims', async () => {
    const pull = JSON.stringify({
      ...JSON.parse(PULL),
      body: 'Part of #17000.',
      closingIssuesReferences: [{ number: 16802 }],
    });

    const report = await collect({ exec: fakeGh({ pull }) });

    assert.deepEqual(report.references, [16802, 17000], 'the closing reference leads; "part of" still counts');
  });

  // Upstream's pull request template has a "What issues does this PR fix or
  // reference?" heading, and contributors fill it with a bare number. That is
  // neither a closing keyword nor a closing reference, so both other sources
  // miss it — found on PR #18464, whose body says exactly this and nothing more.
  test('a bare number under the template heading counts as a reference', async () => {
    const pull = JSON.stringify({
      ...JSON.parse(PULL),
      body: [
        '### What does this PR do?',
        'Backend slice of the thing.',
        '',
        '### What issues does this PR fix or reference?',
        '<!-- Include any related issues from Podman Desktop repository. -->',
        '#16802',
        '',
        '### How to test this PR?',
        'Unrelated prose mentioning #99999.',
      ].join('\n'),
    });

    const report = await collect({ exec: fakeGh({ pull }) });

    assert.deepEqual(report.references, [16802]);
    assert.equal(report.references.includes(99999), false, 'only that one section is read for bare numbers');
  });

  test('the referenced issue comes back read, not just numbered', async () => {
    const report = await collect();

    assert.deepEqual(report.issues.map((issue) => issue.number), [17221, 17000]);
    assert.match(report.issues[0].body, /Users cannot do the thing/);
    assert.match(review.format(report), /#17221 the issue behind #2903/);
  });

  test('an issue that cannot be read leaves the rest of the facts standing', async () => {
    const issue = () => {
      throw new Error('gh: issue not found');
    };

    const report = await collect({ exec: fakeGh({ issue }) });

    assert.deepEqual(report.references, [17221, 17000]);
    assert.equal(report.issues[0].title, null);
    assert.equal(report.diff.files.length, 3);
    assert.match(review.format(report), /could not be read/);
  });

  test('a pull request naming no issue says so, rather than leaving the table to the diff', async () => {
    const pull = JSON.stringify({ ...JSON.parse(PULL), body: 'No issue for this one.' });

    const report = await collect({ exec: fakeGh({ pull }) });

    assert.deepEqual(report.references, []);
    assert.deepEqual(report.issues, []);
    assert.match(review.format(report), /no issue referenced/);
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

    const report = await collect({ exec: fakeGh({ threads: escalating }) });

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
        requirementFit: [
          '| R1 — the thing runs | yes | `packages/main/src/added.ts:1` |',
          '| R2 — it is licensed | no | nowhere: the file has no SPDX header |',
        ],
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

    // An issue has as many requirements as it has, and the table has to hold
    // all of them. One row of three placeholders meant the second requirement
    // had to be smuggled inside the first row's last cell.
    assert.match(document, /^\| R1 — the thing runs \| yes \|/m);
    assert.match(document, /^\| R2 — it is licensed \| no \|/m);
  });
});

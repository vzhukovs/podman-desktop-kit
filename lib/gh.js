// SPDX-License-Identifier: Apache-2.0

// Wrappers around the gh CLI.
//
// Read-only by default. Every function that writes to GitHub goes through
// gate.js first and is listed in WRITE_OPERATIONS below, so the set of things
// that can reach someone else's repository is enumerable rather than implied.
//
// THE GATE IS CHECKED HERE, not only in the hook. lib/hooks/dispatch.js guards
// Bash calls the agent makes; nothing it does can see a child process this
// module spawns. If createPullRequest trusted its caller, the plugin's own
// happy path would be the one route to GitHub with no consent check on it.

import { execFile } from 'node:child_process';

import { get, load } from './config.js';
import * as gate from './gate.js';

/** Operations that mutate GitHub state. Each requires a valid gate token. */
export const WRITE_OPERATIONS = [
  'pr.create',
  'pr.edit',
  'pr.merge',
  'pr.review',
  'issue.comment',
  'thread.reply',
  'thread.resolve',
];

/**
 * Run gh and return stdout.
 *
 * execFile, never a shell: an issue title is attacker-controlled text as far as
 * this process is concerned, and it ends up in argv.
 *
 * @param {string[]} args
 * @param {{input?: string, exec?: Function}} [options]
 * @returns {Promise<string>}
 */
export async function gh(args, options = {}) {
  const runner = options.exec ?? execFile;

  return new Promise((resolve, reject) => {
    const child = runner('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);

      if (error.code === 'ENOENT') {
        return reject(new Error('gh is not installed — see the required dependencies in README.md'));
      }
      const detail = String(stderr ?? '').trim() || error.message;
      return reject(new Error(`gh ${args[0] ?? ''} failed: ${detail}`));
    });

    if (options.input !== undefined && child?.stdin) child.stdin.end(options.input);
  });
}

/**
 * The upstream repository, as `owner/name`.
 *
 * Always passed explicitly. gh infers the repository from the working
 * directory, and in a fork that inference is the wrong one often enough to
 * matter — reads would quietly answer about the fork instead of upstream.
 *
 * @param {object} config
 * @returns {string}
 */
export function upstreamSlug(config) {
  const slug = get(config, 'repo.upstream');
  if (typeof slug !== 'string' || !slug.includes('/')) {
    throw new Error('config: repo.upstream is not set to owner/name');
  }
  return slug;
}

/**
 * The `--head` value for a pull request opened from a fork: `owner:branch`.
 *
 * Without the owner prefix gh looks for the branch in the upstream repository,
 * where it does not exist, and the error it gives does not say why.
 *
 * @param {object} config
 * @param {string} branch
 * @returns {string}
 */
export function headRef(config, branch) {
  const fork = get(config, 'repo.fork');
  if (typeof fork !== 'string' || !fork.includes('/')) {
    throw new Error('config: repo.fork is not set to owner/name');
  }
  return `${fork.split('/')[0]}:${branch}`;
}

/**
 * Fetch an issue with body, labels, comments, and linked PRs.
 *
 * @param {number} number
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<object>}
 */
export async function fetchIssue(number, options = {}) {
  const config = options.config ?? (await load({}));

  const raw = await gh(
    [
      'issue',
      'view',
      String(number),
      '--repo',
      upstreamSlug(config),
      '--json',
      'number,title,body,state,stateReason,labels,author,assignees,createdAt,updatedAt,closedAt,comments,url',
    ],
    options,
  );

  return JSON.parse(raw);
}

/**
 * The issue timeline entries that record a pull request referencing it.
 *
 * GraphQL rather than a search, and the difference is not cosmetic. Searching
 * for the issue number matches the number anywhere in a pull request body —
 * and dependency bumps paste whole upstream changelogs, so a PR bumping svelte
 * "references" podman-desktop#18248 because svelte's own changelog mentions
 * sveltejs/svelte#18248. Triage is told to stop when it sees an open PR, so a
 * false "the work already exists" is the most expensive answer this call can
 * give.
 *
 * CROSS_REFERENCED_EVENT and CONNECTED_EVENT are what GitHub itself uses to
 * populate "linked pull requests", which makes them the authority rather than
 * an approximation of it.
 */
const LINKED_PRS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source { ... on PullRequest { number title state url mergedAt } }
          }
          ... on ConnectedEvent {
            subject { ... on PullRequest { number title state url mergedAt } }
          }
        }
      }
    }
  }
}`;

/**
 * Open and closed PRs referencing an issue. Used for dedup on triage: an
 * existing PR, or a revert, changes the route before any planning starts.
 *
 * Every state, not just open. A closed PR that was reverted is the signal for
 * the `redo` route, and looking only at open ones would miss exactly the case
 * that most needs the archaeology.
 *
 * @param {number} issue
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<Array<{number: number, state: string, title: string, url: string, mergedAt: string|null, isRevert: boolean}>>}
 */
export async function linkedPullRequests(issue, options = {}) {
  const config = options.config ?? (await load({}));
  const [owner, name] = upstreamSlug(config).split('/');

  const raw = await gh(
    [
      'api',
      'graphql',
      '-f',
      `query=${LINKED_PRS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${issue}`,
    ],
    options,
  );

  const nodes = JSON.parse(raw).data?.repository?.issue?.timelineItems?.nodes ?? [];

  const seen = new Map();
  for (const node of nodes) {
    const pr = node.source ?? node.subject;
    // A cross-reference from an issue rather than a pull request has no number
    // here, and the same PR can appear more than once in a timeline.
    if (!pr?.number || seen.has(pr.number)) continue;

    seen.set(pr.number, {
      number: pr.number,
      state: pr.state,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt ?? null,
      isRevert: /^\s*revert\b/i.test(pr.title ?? ''),
    });
  }

  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/**
 * Create a pull request. Requires a valid gate token for the head branch.
 *
 * The token is verified and spent here. A caller that already spent it through
 * the Bash hook is refused, which is correct: one token, one write.
 *
 * @param {{head: string, base?: string, title: string, body: string, token?: string, config?: object, home?: string, exec?: Function}} input
 * @returns {Promise<{number: number|null, url: string}>}
 */
export async function createPullRequest(input) {
  const config = input.config ?? (await load({}));

  const checked = await gate.verify({ branch: input.head, token: input.token, home: input.home });
  if (!checked.valid) throw new Error(`refusing to open a pull request: ${checked.reason}`);

  const base = input.base ?? String(get(config, 'repo.base_branch') ?? 'main');

  // The body goes in on stdin. As an argument it hits the argv limit on a long
  // body, and every quoting bug on that path produces a published pull request
  // with the wrong text in it.
  const output = await gh(
    [
      'pr',
      'create',
      '--repo',
      upstreamSlug(config),
      '--base',
      base,
      '--head',
      headRef(config, input.head),
      '--title',
      input.title,
      '--body-file',
      '-',
    ],
    { input: input.body, exec: input.exec },
  );

  await gate.close(input.head, { home: input.home });

  const url = output.trim().split('\n').filter(Boolean).pop() ?? '';
  const number = Number.parseInt(url.split('/').pop() ?? '', 10);

  return { number: Number.isInteger(number) ? number : null, url };
}

/** What `pr view --json` is asked for. Named once: three callers must agree. */
const PR_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'mergedAt',
  'closedAt',
  'createdAt',
  'updatedAt',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'url',
  'reviewDecision',
  'author',
  'additions',
  'deletions',
  'changedFiles',
  'statusCheckRollup',
].join(',');

/**
 * Normalise one entry of statusCheckRollup.
 *
 * The rollup mixes GitHub Actions check runs with third-party statuses
 * (codecov, cloudflare), and the two spell their outcome differently: a check
 * run has status/conclusion, a status context has state. Flattening here means
 * the rest of the plugin compares like with like.
 *
 * @param {object} entry
 * @returns {{name: string, workflow: string|null, status: string, conclusion: string|null, url: string|null, startedAt: string|null, completedAt: string|null}}
 */
function normaliseCheck(entry) {
  const isStatusContext = entry.__typename === 'StatusContext' || entry.state !== undefined;

  // GitHub writes year zero for "never", and a date that parses but means
  // nothing is worse than no date: it would report a check as 2025 years old.
  const when = (value) => (value && !String(value).startsWith('0001-01-01') ? value : null);

  return {
    name: entry.name ?? entry.context ?? '(unnamed)',
    workflow: entry.workflowName || null,
    status: isStatusContext ? 'COMPLETED' : String(entry.status ?? 'UNKNOWN'),
    conclusion: String(entry.conclusion ?? entry.state ?? '') || null,
    url: entry.detailsUrl ?? entry.targetUrl ?? null,
    startedAt: when(entry.startedAt ?? entry.createdAt),
    completedAt: when(entry.completedAt),
  };
}

/** Conclusions that mean the job came back red. */
export const RED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);

/**
 * Read one pull request, with its CI rollup.
 *
 * @param {number} number
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<object>}
 */
export async function pullRequest(number, options = {}) {
  const config = options.config ?? (await load({}));

  const raw = await gh(['pr', 'view', String(number), '--repo', upstreamSlug(config), '--json', PR_FIELDS], options);
  const pr = JSON.parse(raw);

  return { ...pr, author: pr.author?.login ?? null, checks: (pr.statusCheckRollup ?? []).map(normaliseCheck) };
}

/**
 * Pull requests, for the dashboard and for the peer measurement below.
 *
 * @param {{author?: string, state?: string, limit?: number, config?: object, exec?: Function}} [options]
 * @returns {Promise<object[]>}
 */
export async function pullRequests(options = {}) {
  const config = options.config ?? (await load({}));

  const args = [
    'pr',
    'list',
    '--repo',
    upstreamSlug(config),
    '--state',
    options.state ?? 'open',
    '--limit',
    String(options.limit ?? 20),
    '--json',
    PR_FIELDS,
  ];
  if (options.author) args.push('--author', options.author);

  return JSON.parse(await gh(args, options)).map((pr) => ({
    ...pr,
    author: pr.author?.login ?? null,
    checks: (pr.statusCheckRollup ?? []).map(normaliseCheck),
  }));
}

/**
 * How often each job is red across other people's open pull requests.
 *
 * This is the baseline for "did we break it, or is it red anyway" — the same
 * question `slice verify` answers by re-running the command on a clean base,
 * asked where re-running is not ours to do.
 *
 * The peers are the population rather than the base branch, and that is a
 * measurement rather than a preference: podman-desktop runs `pr-check` on
 * `pull_request`, so those jobs never run on `main` at all. Comparing against
 * the base branch would find no such job for every check and report every red
 * as inconclusive, which is the failure mode this measurement exists to avoid.
 *
 * @param {{exclude?: number, limit?: number, config?: object, exec?: Function}} [options]
 * @returns {Promise<{sampled: number, red: Map<string, number[]>}>} job name -> PRs where it is red
 */
export async function peerCheckFailures(options = {}) {
  const peers = await pullRequests({ ...options, state: 'open', limit: options.limit ?? 15 });

  /** @type {Map<string, number[]>} */
  const red = new Map();
  let sampled = 0;

  for (const peer of peers) {
    if (peer.number === options.exclude) continue;
    sampled += 1;

    for (const check of peer.checks) {
      if (!RED.has(String(check.conclusion))) continue;
      red.set(check.name, [...(red.get(check.name) ?? []), peer.number]);
    }
  }

  return { sampled, red };
}

/**
 * Every check run recorded against a commit, including superseded ones.
 *
 * `pr view` reports the latest run per job; this reports all of them, which is
 * the only way to see a flake: the same job, the same commit, two different
 * answers. Without it a re-run that went green erases the evidence that it was
 * ever red.
 *
 * @param {string} sha
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<Array<{name: string, conclusion: string|null, startedAt: string|null}>>}
 */
export async function checkRunsForCommit(sha, options = {}) {
  const config = options.config ?? (await load({}));

  // One page of a hundred, deliberately: a single commit does not have more
  // check runs than that, and --paginate without --slurp emits several JSON
  // documents in a row, which is a parsing problem invented for no gain.
  const raw = await gh(['api', `repos/${upstreamSlug(config)}/commits/${sha}/check-runs?per_page=100`], options);

  return (JSON.parse(raw).check_runs ?? []).map((run) => ({
    name: run.name,
    conclusion: run.conclusion ? String(run.conclusion).toUpperCase() : null,
    startedAt: run.started_at ?? null,
  }));
}

/**
 * Review threads for a PR, via GraphQL.
 *
 * GraphQL rather than REST because REST does not expose whether a thread is
 * resolved, and "which threads are still open" is the entire question
 * /pd:pr-sync asks.
 *
 * Resolved threads come back too. A thread resolved by someone else since the
 * last sync is not noise — it is the difference between "the reviewer is
 * waiting" and "the reviewer moved on".
 */
const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 30) {
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

/**
 * @typedef {object} Thread
 * @property {string} id
 * @property {boolean} isResolved
 * @property {boolean} isOutdated
 * @property {string|null} path
 * @property {number|null} line
 * @property {string|null} author        who opened the thread
 * @property {string} body               the first comment, which is the ask
 * @property {string|null} url
 * @property {string|null} createdAt
 * @property {number} replies
 */

/**
 * @param {number} pr
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<Thread[]>}
 */
export async function reviewThreads(pr, options = {}) {
  const config = options.config ?? (await load({}));
  const [owner, name] = upstreamSlug(config).split('/');

  /** @type {Thread[]} */
  const threads = [];
  let cursor = null;

  // Paginated for real. A long-running PR with a chatty bot passes fifty
  // threads, and silently reading the first page would drop exactly the
  // threads that have been waiting longest.
  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${pr}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);

    const page = JSON.parse(await gh(args, options)).data?.repository?.pullRequest?.reviewThreads;

    for (const node of page?.nodes ?? []) {
      const comments = node.comments?.nodes ?? [];
      const first = comments[0];

      threads.push({
        id: node.id,
        isResolved: Boolean(node.isResolved),
        isOutdated: Boolean(node.isOutdated),
        path: node.path ?? null,
        line: node.line ?? node.originalLine ?? null,
        author: first?.author?.login ?? null,
        body: first?.body ?? '',
        url: first?.url ?? null,
        createdAt: first?.createdAt ?? null,
        replies: Math.max(0, comments.length - 1),
      });
    }

    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return threads;
}

/**
 * Review submissions and top-level comments — the feedback that is not in a
 * thread.
 *
 * Not an optional extra. On PR #17577, the pull request this stage was built
 * against, both open review threads are coderabbit's, while the reason the PR
 * is blocked is a 240-character CHANGES_REQUESTED review body and a
 * 92-character issue comment. A sync that read only `reviewThreads` would have
 * reported two bot threads and missed every word a human wrote.
 *
 * One gh call for both, because they arrive from the same view and asking
 * twice would let them describe different moments.
 *
 * @param {number} pr
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<{reviews: Array<object>, comments: Array<object>}>}
 */
export async function discussion(pr, options = {}) {
  const config = options.config ?? (await load({}));

  const raw = await gh(
    ['pr', 'view', String(pr), '--repo', upstreamSlug(config), '--json', 'reviews,comments'],
    options,
  );
  const view = JSON.parse(raw);

  return {
    // A review with an empty body and a state of APPROVED said something
    // ("looks fine") without writing anything, so it is kept: the state is the
    // content. An empty COMMENTED review is the wrapper around inline threads
    // and carries nothing, so it is dropped.
    reviews: (view.reviews ?? [])
      .map((review) => ({
        author: review.author?.login ?? null,
        state: review.state ?? null,
        body: review.body ?? '',
        at: review.submittedAt ?? null,
        url: review.url ?? null,
      }))
      .filter((review) => review.body.trim() !== '' || review.state !== 'COMMENTED'),

    comments: (view.comments ?? []).map((comment) => ({
      author: comment.author?.login ?? null,
      body: comment.body ?? '',
      at: comment.createdAt ?? null,
      url: comment.url ?? null,
    })),
  };
}

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { url }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } }
}`;

/**
 * Reply to a review thread, and optionally resolve it.
 *
 * Gated here as well as in the hook, for the same reason createPullRequest is:
 * the Bash hook cannot see a child process this module spawns, so without this
 * the plugin's own path would be the one route to GitHub with no consent on it.
 *
 * The token is a `reply` token scoped to the pull request rather than a branch,
 * and it is NOT spent here. The unit of consent for replies is the batch the
 * human read in one go; spending on the first reply would refuse the other
 * seven they just approved. The TTL still bounds it, and pr-sync closes the
 * token when the batch is done.
 *
 * Resolving is separate from replying and happens after it. A thread resolved
 * before the reply lands is a thread the reviewer sees closed with no answer
 * in it.
 *
 * @param {{pr: number, threadId: string, body: string, resolve?: boolean, token?: string, config?: object, home?: string, exec?: Function}} input
 * @returns {Promise<{url: string|null, resolved: boolean}>}
 */
export async function replyToThread(input) {
  const checked = await gate.verify({ pr: input.pr, kind: 'reply', token: input.token, home: input.home });
  if (!checked.valid) throw new Error(`refusing to reply on #${input.pr}: ${checked.reason}`);

  const reply = await gh(
    ['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-f', `threadId=${input.threadId}`, '-f', `body=${input.body}`],
    { exec: input.exec },
  );

  let resolved = false;
  if (input.resolve) {
    const done = await gh(
      ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${input.threadId}`],
      { exec: input.exec },
    );
    resolved = Boolean(JSON.parse(done).data?.resolveReviewThread?.thread?.isResolved);
  }

  return { url: JSON.parse(reply).data?.addPullRequestReviewThreadReply?.comment?.url ?? null, resolved };
}

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
 *
 * `repository` is selected because a cross-reference can come from anywhere on
 * GitHub. Issue #18381 is referenced by yuvalgalanti/AppDev-UX-Prototypes#17,
 * a merged pull request in a stranger's repository — and without the filter
 * below it read as "this was already implemented upstream". That is the same
 * false "the work already exists" the search was replaced to avoid, arriving
 * by a different route.
 */
const LINKED_PRS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source { ... on PullRequest { number title state url mergedAt body repository { nameWithOwner } } }
          }
          ... on ConnectedEvent {
            subject { ... on PullRequest { number title state url mergedAt repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/**
 * Keep only the pull requests that live in the repository being asked about.
 *
 * Shared by the single-issue read and the batch one, so the two cannot come to
 * different conclusions about what "linked" means.
 *
 * @param {Array<object>} nodes    timelineItems nodes
 * @param {string} slug            owner/name the answer is about
 * @returns {Array<{number: number, state: string, title: string, url: string, mergedAt: string|null, isRevert: boolean}>}
 */
/** `Revert "…"`, `revert(renderer): …` — the shape GitHub's own revert button makes. */
const REVERT_TITLE = /^\s*revert\b/i;

/** What a revert says about itself when its title does not lead with the word. */
const REVERTS_SOMETHING = /\brevert(?:s|ed|ing)?\b[^.\n]{0,40}?(?:pr\s*)?#(\d+)|this reverts commit\s+([0-9a-f]{7,40})/i;

/**
 * Whether this pull request undoes something, and what.
 *
 * The title test alone is where the `redo` route broke. Measured on issue
 * #17873: the attempt is #17976 and the pull request that backed it out is
 * #18323, titled `fix(renderer): revert extension details summary card to
 * vertical…`. The word is there and it is not first, so the pair was never
 * established, the fallback took the newest merge — an unrelated feature, #17299
 * — and the report said "merged and nothing reverts it". Every number in it was
 * real and the relationship was invented, which is the failure decision 63 was
 * written to prevent, arriving through a different door.
 *
 * So a revert is recognised by what it says it reverts, and the title shape
 * stays as one signal rather than the only one. The body is asked for in the
 * same queries that already ran, so this costs no extra request.
 *
 * @param {{title?: string, body?: string}} pr
 * @returns {{isRevert: boolean, reverts: number|null}}
 */
export function revertOf(pr) {
  const title = String(pr?.title ?? '');
  const said = REVERTS_SOMETHING.exec(`${title}\n${String(pr?.body ?? '')}`);
  const number = said?.[1] ? Number(said[1]) : null;

  return { isRevert: REVERT_TITLE.test(title) || Boolean(said), reverts: number };
}

export function linkedFromTimeline(nodes, slug) {
  const seen = new Map();

  for (const node of nodes ?? []) {
    const pr = node.source ?? node.subject;
    // A cross-reference from an issue rather than a pull request has no number
    // here, and the same PR can appear more than once in a timeline.
    if (!pr?.number || seen.has(pr.number)) continue;
    // Someone else's repository. Their #17 is not our #17.
    if (pr.repository?.nameWithOwner && pr.repository.nameWithOwner !== slug) continue;

    const { isRevert, reverts } = revertOf(pr);

    seen.set(pr.number, {
      number: pr.number,
      state: pr.state,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt ?? null,
      isRevert,
      reverts,
    });
  }

  return [...seen.values()].sort((a, b) => a.number - b.number);
}

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
  const slug = upstreamSlug(config);
  const [owner, name] = slug.split('/');

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

  return linkedFromTimeline(JSON.parse(raw).data?.repository?.issue?.timelineItems?.nodes ?? [], slug);
}

/**
 * The same question, asked about a pull request instead of an issue.
 *
 * Needed because a revert references what it reverts, and what it reverts is a
 * pull request. Found live: podman-desktop#17829 ("revert: #16294") does not
 * appear anywhere in the timeline of issue #12775, which #16294 closed — so an
 * archaeology that only asked the issue reported a merged attempt and no
 * revert, which is the shape of "this landed and is still there".
 */
const LINKED_TO_PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source { ... on PullRequest { number title state url mergedAt body repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/**
 * Pull requests that reference a pull request.
 *
 * @param {number} pr
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<Array<{number: number, state: string, title: string, url: string, mergedAt: string|null, isRevert: boolean}>>}
 */
export async function linkedToPullRequest(pr, options = {}) {
  const config = options.config ?? (await load({}));
  const slug = upstreamSlug(config);
  const [owner, name] = slug.split('/');

  const raw = await gh(
    ['api', 'graphql', '-f', `query=${LINKED_TO_PR_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`],
    options,
  );

  return linkedFromTimeline(JSON.parse(raw).data?.repository?.pullRequest?.timelineItems?.nodes ?? [], slug).filter(
    (linked) => linked.number !== pr,
  );
}

/**
 * Open issues, ordered by GitHub's idea of recency, with the timeline and the
 * tail of the discussion attached (spec section 10, scenario 6).
 *
 * The ordering here is not the ordering the command prints. It is only what
 * makes the page a page — `updatedAt` moves when a stale bot posts, and
 * lib/backlog.js re-orders on activity that a human caused.
 */
const BACKLOG_QUERY = `
query($owner: String!, $name: String!, $limit: Int!, $labels: [String!]) {
  repository(owner: $owner, name: $name) {
    issues(first: $limit, states: OPEN, labels: $labels, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        body
        state
        createdAt
        updatedAt
        author { login }
        assignees(first: 10) { nodes { login } }
        labels(first: 20) { nodes { name } }
        comments(last: 20) {
          totalCount
          nodes { author { login __typename } authorAssociation createdAt }
        }
        timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent {
              source { ... on PullRequest { number title state url mergedAt body repository { nameWithOwner } } }
            }
            ... on ConnectedEvent {
              subject { ... on PullRequest { number title state url mergedAt repository { nameWithOwner } } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Open issues with everything the readiness facts are computed from.
 *
 * One request for the whole batch, and that is the design rather than a
 * micro-optimisation. The obvious shape — list the issues, then ask about each
 * one — is twenty round trips for twenty candidates, and the list endpoint does
 * not carry comments at all (`gh issue list --json comments` returns empty
 * arrays), so the per-issue call could not be skipped. Asking GraphQL once
 * costs about a second and answers about the same moment for every issue.
 *
 * `repository.issues` excludes pull requests. The REST issues endpoint does
 * not, and a backlog listing that quietly included pull requests would be
 * offering work that is already written.
 *
 * `__typename` on the comment author is asked for deliberately: GraphQL returns
 * the stale bot as login `github-actions`, without the `[bot]` suffix that
 * threads.isBot recognises, so the suffix alone would read an automated stale
 * notice as a human answering the reporter.
 *
 * @param {{labels?: string[], limit?: number, config?: object, exec?: Function}} [options]
 * @returns {Promise<object[]>}
 */
export async function openIssues(options = {}) {
  const config = options.config ?? (await load({}));
  const slug = upstreamSlug(config);
  const [owner, name] = slug.split('/');

  // A hundred is the GraphQL page maximum. Refusing to page past it is
  // deliberate: choosing what to work on next is a decision over a shortlist,
  // and a command that answered it with four hundred issues would be answering
  // a different question.
  const limit = Math.min(Math.max(1, Number(options.limit) || 20), 100);

  const args = [
    'api',
    'graphql',
    '-f',
    `query=${BACKLOG_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `limit=${limit}`,
  ];
  for (const label of options.labels ?? []) args.push('-f', `labels[]=${label}`);

  const nodes = JSON.parse(await gh(args, options)).data?.repository?.issues?.nodes ?? [];

  return nodes.map((node) => ({
    number: node.number,
    title: node.title ?? '',
    url: node.url ?? '',
    body: node.body ?? '',
    state: node.state ?? 'OPEN',
    author: node.author?.login ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
    assignees: (node.assignees?.nodes ?? []).map((assignee) => assignee.login),
    comments: {
      total: node.comments?.totalCount ?? 0,
      // The last twenty. An issue with more comments than that has been
      // discussed enough that the recent end is what says whether anyone is
      // still on it.
      recent: (node.comments?.nodes ?? []).map((comment) => ({
        author: comment.author?.login ?? null,
        isBotAccount: comment.author?.__typename === 'Bot',
        association: comment.authorAssociation ?? null,
        at: comment.createdAt ?? null,
      })),
    },
    pulls: linkedFromTimeline(node.timelineItems?.nodes ?? [], slug),
  }));
}

/**
 * Create a pull request. Requires a valid gate token for the head branch.
 *
 * The token is verified and spent here. A caller that already spent it through
 * the Bash hook is refused, which is correct: one token, one write.
 *
 * The base is returned along with the number, and returning it is not a
 * convenience: `pr.register` used to record whatever the caller said the base
 * was, which on the first multi-slice live run was a stacked slice's branch
 * while the pull request had in fact opened against `main`. A record of a write
 * comes from the write (spec section 2.2, invariant 5).
 *
 * @param {{head: string, base?: string, title: string, body: string, token?: string, config?: object, home?: string, exec?: Function}} input
 * @returns {Promise<{number: number|null, url: string, base: string}>}
 */
export async function createPullRequest(input) {
  const config = input.config ?? (await load({}));

  // `use: 'pr'` is the half of the push token the push did not spend. Opening
  // the pull request is the second write of one consent — the human read this
  // body and this branch together at `gate open` — and it is still single-use,
  // so a second pull request off the same token is refused like a second push.
  const checked = await gate.verify({ branch: input.head, use: 'pr', token: input.token, home: input.home });
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

  await gate.close(input.head, { home: input.home, use: 'pr' });

  const url = output.trim().split('\n').filter(Boolean).pop() ?? '';
  const number = Number.parseInt(url.split('/').pop() ?? '', 10);

  return { number: Number.isInteger(number) ? number : null, url, base };
}

/**
 * Whether a branch exists in the upstream repository.
 *
 * Asked before a stacked slice is published, and the answer is almost always
 * no: the slice's base is a branch of the fork, and the base of a pull request
 * has to be a branch of the repository it opens against. Nothing in the plugin
 * knew that until a pull request was opened against `main` carrying the
 * previous slice's work, with a body that said it carried none.
 *
 * A lookup failure is reported as "unknown" rather than as absent. Refusing to
 * publish because the network was down would be this function answering a
 * question it did not ask.
 *
 * @param {string} branch
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<boolean|null>} null when the lookup itself failed
 */
export async function upstreamBranchExists(branch, options = {}) {
  const config = options.config ?? (await load({}));

  try {
    await gh(['api', `repos/${upstreamSlug(config)}/branches/${encodeURIComponent(branch)}`, '--jq', '.name'], options);
    return true;
  } catch (error) {
    // gh exits non-zero for a 404 and for everything else alike, so the message
    // is the only thing that separates "no such branch" from "no network".
    return /404|not found|no such/i.test(String(error?.message ?? '')) ? false : null;
  }
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
  'labels',
  'additions',
  'deletions',
  'changedFiles',
  'statusCheckRollup',
].join(',');

/**
 * What reviewing someone else's pull request needs on top of PR_FIELDS.
 *
 * `body` is not in PR_FIELDS because `pr list` asks for twenty pull requests at
 * a time to build a dashboard that shows none of them a body. It is here
 * because the body is where a pull request names the issue it is for, and
 * without the issue the Requirement fit table is a guess wearing a table.
 *
 * Leaving it out was silent in exactly the way that costs the most: the field
 * was never requested, so `pull.body` was always undefined, so the reference
 * scan in lib/review.js always matched nothing and always returned `[]` — for
 * every pull request, for as long as it had been there. Nothing threw.
 */
export const PR_REVIEW_FIELDS = [PR_FIELDS, 'body', 'closingIssuesReferences'].join(',');

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
 * Read one pull request, with its CI rollup unless `fields` says otherwise.
 *
 * @param {number} number
 * @param {{config?: object, fields?: string, exec?: Function}} [options]
 * @returns {Promise<object>}
 */
export async function pullRequest(number, options = {}) {
  const config = options.config ?? (await load({}));

  const raw = await gh(
    ['pr', 'view', String(number), '--repo', upstreamSlug(config), '--json', options.fields ?? PR_FIELDS],
    options,
  );
  const pr = JSON.parse(raw);

  return { ...pr, author: pr.author?.login ?? null, checks: (pr.statusCheckRollup ?? []).map(normaliseCheck) };
}

/** Enough to measure a pull request's size and how long it took. */
export const PR_SHAPE_FIELDS = ['number', 'title', 'author', 'additions', 'deletions', 'changedFiles', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'state'].join(',');

/**
 * Pull requests, for the dashboard and for the peer measurement below.
 *
 * `fields` exists for one caller: a sample of a hundred merged pull requests
 * does not need `statusCheckRollup`, and asking for it turns a question about
 * sizes into one rollup fetch per pull request.
 *
 * @param {{author?: string, state?: string, limit?: number, fields?: string, config?: object, exec?: Function}} [options]
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
    options.fields ?? PR_FIELDS,
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

  // `filter=all`, and it is the whole reason this function exists rather than
  // reading the rollup. The default is `filter=latest`, which returns one run
  // per check name — so after a re-run the failure is gone and every caller sees
  // the same thing `gh pr view` shows. The flake test downstream compares two
  // answers for one job on one commit, and with the default it is comparing a
  // single run against itself: it could never fire, on any pull request, ever.
  //
  // Measured on #18779, where three jobs went red and were re-run green:
  // `filter=latest` returned 1 run for `k8s sanity e2e tests`, `filter=all`
  // returned 3 — two successes and the failure. Section 13 listed flake
  // detection as never having fired live, and this is why.
  //
  // One page of a hundred, deliberately: a single commit does not have more
  // check runs than that, and --paginate without --slurp emits several JSON
  // documents in a row, which is a parsing problem invented for no gain.
  const raw = await gh(
    ['api', `repos/${upstreamSlug(config)}/commits/${sha}/check-runs?per_page=100&filter=all`],
    options,
  );

  return (JSON.parse(raw).check_runs ?? []).map((run) => ({
    name: run.name,
    conclusion: run.conclusion ? String(run.conclusion).toUpperCase() : null,
    startedAt: run.started_at ?? null,
  }));
}

/** How much of a failed job's log is worth reading without opening the browser. */
export const LOG_TAIL_LINES = 40;

/**
 * Lines kept after the error marker.
 *
 * Two, from the same measurement: on #18590 the marker is followed by one line
 * that records the outcome and then by cleanup. Keeping more buys credential
 * removal at the price of the output that led to the failure.
 */
const LOG_LINES_AFTER_ERROR = 2;

/** A job URL: .../actions/runs/<run>/job/<job>. Anything else is not an Actions job. */
const JOB_URL = /\/actions\/runs\/\d+\/jobs?\/(\d+)/;

/** How the runner marks the thing that failed. */
const ERROR_MARKER = /##\[error\]/;

/** `<job>\t<step>\t<ISO timestamp> <text>` — the same 60 characters on every line. */
const LOG_PREFIX = /^[^\t]*\t[^\t]*\t﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

/**
 * A window onto a failing job's log, positioned where the failure is.
 *
 * A window rather than the log, because these run to tens of thousands of lines
 * and the useful part is around the first error. `dropped` and `trailing` are
 * reported so the reader knows they are looking at an excerpt — a silent
 * truncation reads as the whole thing, and `anchor` says whether the window
 * found an error or simply took the end.
 *
 * @typedef {object} JobLog
 * @property {boolean} available
 * @property {string|null} jobId
 * @property {string[]} lines     the window, oldest first
 * @property {'error'|'tail'} anchor what the window was positioned on
 * @property {number} dropped     lines before the window
 * @property {number} trailing    lines after it
 * @property {string|null} reason why there is nothing, when there is nothing
 */

/**
 * The log of the failed steps of one CI job.
 *
 * `pdkit pr ci` measures whether a red job is ours (section 4), and measurement
 * settles it often. What it cannot settle is the part scenario 9 leaves to the
 * model: platform difference or real regression. That question is answered by
 * the failure text and by nothing else — a job name and a URL leave the model
 * guessing from the word "Windows", which is exactly the reasoning-instead-of-
 * reading this plugin exists to replace.
 *
 * Degrades instead of throwing, in three shapes that are genuinely different:
 *
 *   - not an Actions job at all. External status contexts — codecov, the domain
 *     review bot — publish a target URL that is not a run, and have no log to
 *     fetch. Saying "unavailable" without saying that would read as a fetch
 *     that failed;
 *   - gh refused: logs expire (90 days upstream), a run can be deleted, and a
 *     token can lack the scope. The reason is passed through verbatim;
 *   - the job has no failed step: a job red because it was cancelled mid-way,
 *     or one whose failure lives in the run's setup rather than in any step.
 *
 * A report that lost one log is worth more than no report, so none of these
 * stops `pr ci` — the same reason a missing script is a `skip` with an
 * explanation rather than a `pass` (section 7).
 *
 * @param {string|null} url the job's URL, as GitHub gave it
 * @param {{config?: object, exec?: Function, lines?: number}} [options]
 * @returns {Promise<JobLog>}
 */
export async function failedJobLog(url, options = {}) {
  const empty = { available: false, jobId: null, lines: [], anchor: /** @type {'tail'} */ ('tail'), dropped: 0, trailing: 0 };

  const match = JOB_URL.exec(String(url ?? ''));
  if (!match) {
    return { ...empty, reason: `not a GitHub Actions job — ${url ?? 'no URL'} has no log to fetch` };
  }

  const config = options.config ?? (await load({}));
  const jobId = match[1];

  let raw;
  try {
    // --log-failed rather than --log: the whole log of a Windows e2e job is
    // tens of thousands of lines, and every one of them that passed is a line
    // between the reader and the failure.
    raw = await gh(['run', 'view', '--repo', upstreamSlug(config), '--job', jobId, '--log-failed'], options);
  } catch (error) {
    return { ...empty, jobId, reason: String(error.message ?? error) };
  }

  const all = String(raw)
    .split('\n')
    .filter((line) => line.trim() !== '')
    // The prefix is the job name, the step name and a timestamp, identical on
    // every line of a job. Sixty characters of it per line push the failure off
    // the right edge of a terminal and out of a context window for nothing.
    .map((line) => line.replace(LOG_PREFIX, '').trimEnd());

  if (all.length === 0) {
    return { ...empty, jobId, reason: 'gh returned no failed-step log — a cancelled job, or a failure outside any step' };
  }

  const limit = options.lines ?? LOG_TAIL_LINES;

  // Not the tail. Measured on a real failure (#18590, "podman desktop",
  // 245 lines): `##[error]Process completed with exit code 100` sits 50 lines
  // from the end, and everything after it is the runner removing credentials
  // and cleaning up orphan processes. A 40-line tail showed all cleanup and no
  // failure — confidently, and with no sign that it had missed anything.
  //
  // So the window is anchored on the last error marker, keeping the output that
  // led to it and a few lines below. Without a marker there is nothing to
  // anchor on and the tail is the honest fallback — which is why `anchor` is
  // reported rather than assumed: the two windows are worth different amounts,
  // and only one of them is known to contain the failure.
  let last = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (ERROR_MARKER.test(all[i])) {
      last = i;
      break;
    }
  }

  const end = last === -1 ? all.length : Math.min(all.length, last + 1 + LOG_LINES_AFTER_ERROR);
  const start = Math.max(0, end - limit);

  return {
    available: true,
    jobId,
    lines: all.slice(start, end),
    anchor: last === -1 ? 'tail' : 'error',
    // Both ends are counted. A window that reports what it cut from the front
    // and stays silent about the back implies the log ended where it stopped.
    dropped: start,
    trailing: all.length - end,
    reason: null,
  };
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
            nodes { author { login __typename } body createdAt url }
          }
        }
      }
    }
  }
}`;

/**
 * One review thread on somebody else's pull request.
 *
 * `body` is the first comment because that is the ask; the replies are counted
 * rather than carried, since the question a sync starts from is what was
 * requested and whether it is still open. `isBotAccount` comes from GitHub's own
 * classification rather than a list of names kept here, which would go stale
 * silently and start reading a person as a bot.
 *
 * @typedef {object} Thread
 * @property {string} id
 * @property {boolean} isResolved
 * @property {boolean} isOutdated
 * @property {string|null} path
 * @property {number|null} line
 * @property {string|null} author        who opened the thread
 * @property {boolean} isBotAccount      GitHub's own answer, not a name we listed
 * @property {string} body               the first comment, which is the ask
 * @property {string|null} url
 * @property {string|null} createdAt
 * @property {number} replies
 */

/**
 * Every review thread on a pull request, following pagination to the end.
 *
 * All of them, including resolved and outdated ones, because the caller decides
 * what to show and a filter here would be a decision taken where it cannot be
 * seen. Paginated rather than capped: a busy pull request has more than a
 * hundred, and a silent first page reads as the whole conversation.
 *
 * GraphQL rather than REST — thread identity, resolution state and the reply
 * mutation exist only there, and the id returned here is what a reply is
 * addressed to.
 *
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
        isBotAccount: first?.author?.__typename === 'Bot',
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

/** Reviews and issue comments in one round trip, with the author's account type. */
const DISCUSSION_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100) {
        nodes { author { login __typename } state body submittedAt url }
      }
      comments(first: 100) {
        nodes { author { login __typename } body createdAt url }
      }
    }
  }
}`;

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
 * GraphQL rather than `gh pr view --json reviews,comments`, which was the call
 * here until 0.20 and cannot answer the one question that matters for folding:
 * it returns `{"login": "copilot-pull-request-reviewer"}` and nothing else.
 * The REST and GraphQL forms of the same account are
 * `copilot-pull-request-reviewer[bot]` and `__typename: "Bot"`; `gh pr view`
 * strips the suffix and offers no type, so every bot not written down by name
 * arrived here looking like a person. Still one call.
 *
 * @param {number} pr
 * @param {{config?: object, exec?: Function}} [options]
 * @returns {Promise<{reviews: Array<object>, comments: Array<object>}>}
 */
export async function discussion(pr, options = {}) {
  const config = options.config ?? (await load({}));
  const [owner, name] = upstreamSlug(config).split('/');

  const raw = await gh(
    ['api', 'graphql', '-f', `query=${DISCUSSION_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`],
    options,
  );
  const view = JSON.parse(raw).data?.repository?.pullRequest ?? {};

  return {
    // A review with an empty body and a state of APPROVED said something
    // ("looks fine") without writing anything, so it is kept: the state is the
    // content. An empty COMMENTED review is the wrapper around inline threads
    // and carries nothing, so it is dropped.
    reviews: (view.reviews?.nodes ?? [])
      .map((review) => ({
        author: review.author?.login ?? null,
        isBotAccount: review.author?.__typename === 'Bot',
        state: review.state ?? null,
        body: review.body ?? '',
        at: review.submittedAt ?? null,
        url: review.url ?? null,
      }))
      .filter((review) => review.body.trim() !== '' || review.state !== 'COMMENTED'),

    comments: (view.comments?.nodes ?? []).map((comment) => ({
      author: comment.author?.login ?? null,
      isBotAccount: comment.author?.__typename === 'Bot',
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

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

/**
 * Unresolved review threads for a PR, via GraphQL. REST does not expose
 * thread resolution state, which is the whole point of this call.
 *
 * @param {number} _pr
 * @returns {Promise<Array<{id: string, path: string, line: number, author: string, body: string, isBot: boolean}>>}
 */
export async function reviewThreads(_pr) {
  // TODO(stage 4)
  throw new Error('not implemented');
}

/**
 * CI check runs for a PR, including per-platform job status.
 *
 * @param {number} _pr
 * @returns {Promise<Array<{name: string, status: string, conclusion: string, platform: string|null}>>}
 */
export async function checks(_pr) {
  // TODO(stage 4)
  throw new Error('not implemented');
}

/**
 * Reply to a review thread and resolve it. Requires a gate token.
 *
 * @param {{threadId: string, body: string, resolve: boolean, token: string}} _input
 * @returns {Promise<void>}
 */
export async function replyToThread(_input) {
  // TODO(stage 4)
  throw new Error('not implemented');
}

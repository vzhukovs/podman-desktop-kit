// SPDX-License-Identifier: Apache-2.0

// Wrappers around the gh CLI.
//
// Read-only by default. Every function that writes to GitHub goes through
// gate.js first and is listed in WRITE_OPERATIONS below, so the set of things
// that can reach someone else's repository is enumerable rather than implied.

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
 * Fetch an issue with body, labels, comments, and linked PRs.
 *
 * @param {number} _number
 * @returns {Promise<object>}
 */
export async function fetchIssue(_number) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Open and closed PRs referencing an issue. Used for dedup on triage: an
 * existing PR, or a revert, changes the route before any planning starts.
 *
 * @param {number} _issue
 * @returns {Promise<Array<{number: number, state: string, title: string}>>}
 */
export async function linkedPullRequests(_issue) {
  // TODO(stage 1)
  throw new Error('not implemented');
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
 * Create a pull request. Requires a gate token for the head branch.
 *
 * @param {{head: string, base: string, title: string, body: string, token: string}} _input
 * @returns {Promise<{number: number, url: string}>}
 */
export async function createPullRequest(_input) {
  // TODO(stage 1)
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

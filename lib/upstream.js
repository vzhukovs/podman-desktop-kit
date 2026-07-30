// SPDX-License-Identifier: Apache-2.0

// Primitives for the upstream rules of podman-desktop.
//
// Shared on purpose: hooks enforce these live (post-write SPDX, commit checks)
// and preflight verifies them in batch. Two implementations of "what counts as
// a valid SPDX header" would eventually disagree, and the disagreement would
// surface as a hook passing something preflight then rejects.

/** The SPDX header every new source file must carry. */
export const SPDX_HEADER = 'SPDX-License-Identifier: Apache-2.0';

/** Conventional commit types accepted upstream. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

/** File extensions that require an SPDX header. */
export const SPDX_REQUIRED_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.svelte', '.css', '.scss'];

/**
 * Whether a file needs an SPDX header, and whether it has one.
 *
 * @param {{path: string, content: string}} _file
 * @returns {{required: boolean, present: boolean, insert: string|null}}
 */
export function checkSpdx(_file) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Parse a commit subject into type, scope, and description.
 *
 * @param {string} _subject
 * @returns {{type: string, scope: string|null, description: string, breaking: boolean}|null} null when it does not parse
 */
export function parseCommitSubject(_subject) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Validate a commit against upstream rules: known type, package scope present,
 * exactly one Signed-off-by trailer.
 *
 * @param {{subject: string, trailers: Record<string, string[]>}} _commit
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateCommit(_commit) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Whether a changed path is part of the public extension API surface.
 *
 * This is the RunOptions trap codified: a type can live in
 * packages/main/src/plugin/util/exec.ts and look like an internal helper while
 * also being declared in extension-api.d.ts, which makes it public API. It is a
 * grep, not a judgement call, which is exactly why it belongs in code.
 *
 * @param {{symbols: string[], repoRoot: string}} _input
 * @returns {Promise<Array<{symbol: string, public: boolean, declaredAt: string|null}>>}
 */
export async function classifyApiSurface(_input) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

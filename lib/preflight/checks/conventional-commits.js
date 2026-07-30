// SPDX-License-Identifier: Apache-2.0

// Preflight check: conventional-commits
//
// Every commit on the branch has a valid type and a package scope.
//
// The scope is not decoration: it is how upstream routes review.

/** @type {import('../index.js').Check['id']} */
export const id = 'conventional-commits';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

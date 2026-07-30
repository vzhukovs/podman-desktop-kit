// SPDX-License-Identifier: Apache-2.0

// Preflight check: signed-off-by
//
// Exactly one Signed-off-by trailer per commit.
//
// Zero fails DCO. Two is what an interactive rebase produces after Husky has
// already added one, and upstream rejects it.

/** @type {import('../index.js').Check['id']} */
export const id = 'signed-off-by';

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

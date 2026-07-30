// SPDX-License-Identifier: Apache-2.0

// Preflight check: steps-to-check
//
// The PR body has at least three verification steps, each with an expected
// result.
//
// Applies on the quickfix route too. A small diff does not make a reviewer
// better at guessing what to look at.

/** @type {import('../index.js').Check['id']} */
export const id = 'steps-to-check';

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

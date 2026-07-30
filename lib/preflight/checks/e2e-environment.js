// SPDX-License-Identifier: Apache-2.0

// Preflight check: e2e-environment
//
// A test needing an environment CI does not have is declared in
// Notes for reviewers.

/** @type {import('../index.js').Check['id']} */
export const id = 'e2e-environment';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  // TODO(stage 5)
  throw new Error('not implemented');
}

// SPDX-License-Identifier: Apache-2.0

// Preflight check: e2e-stability
//
// A newly added e2e test passed validation.e2e_stability_runs times in a row.
//
// A flake you bring into someone else’s repository is the worst thing you can
// bring. Three consecutive local runs is the cheapest defence.

/** @type {import('../index.js').Check['id']} */
export const id = 'e2e-stability';

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

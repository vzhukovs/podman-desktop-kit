// SPDX-License-Identifier: Apache-2.0

// Preflight check: ci-blind-spots
//
// A diff touching build, packaging, or platform behaviour declares what CI
// cannot verify.
//
// CI going green on a change it never exercised is worse than CI failing:
// it reads as proof.

/** @type {import('../index.js').Check['id']} */
export const id = 'ci-blind-spots';

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

// SPDX-License-Identifier: Apache-2.0

// Preflight check: e2e environment
//
// A test that needs an environment CI does not have must say so in Notes for
// reviewers rather than quietly fail there.
//
// Skipped until stage 5, with e2e-stability.

/** @type {string} */
export const id = 'e2e-environment';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  return { id, status: 'skip', blocking, summary: 'e2e generation lands in stage 5' };
}

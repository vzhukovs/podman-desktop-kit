// SPDX-License-Identifier: Apache-2.0

// Preflight check: slice-standalone
//
// Slices declaring base main actually build alone from main.
//
// Only applies to slices with base: main. Stacked slices are expected to fail
// standalone; that is what makes them stacked.

/** @type {import('../index.js').Check['id']} */
export const id = 'slice-standalone';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  // TODO(stage 3)
  throw new Error('not implemented');
}

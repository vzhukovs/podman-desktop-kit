// SPDX-License-Identifier: Apache-2.0

// Preflight check: tests
//
// Run pnpm test scoped to the packages the diff touches.

/** @type {import('../index.js').Check['id']} */
export const id = 'tests';

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

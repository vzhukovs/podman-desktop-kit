// SPDX-License-Identifier: Apache-2.0

// Preflight check: lint
//
// Run pnpm lint.

/** @type {import('../index.js').Check['id']} */
export const id = 'lint';

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

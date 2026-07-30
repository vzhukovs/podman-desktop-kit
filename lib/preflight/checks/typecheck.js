// SPDX-License-Identifier: Apache-2.0

// Preflight check: typecheck
//
// Run pnpm typecheck.

/** @type {import('../index.js').Check['id']} */
export const id = 'typecheck';

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

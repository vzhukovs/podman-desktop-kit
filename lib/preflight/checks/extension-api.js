// SPDX-License-Identifier: Apache-2.0

// Preflight check: extension-api
//
// A diff touching extension-api.d.ts carries the backward compatibility
// and disposal section in the PR body.

/** @type {import('../index.js').Check['id']} */
export const id = 'extension-api';

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

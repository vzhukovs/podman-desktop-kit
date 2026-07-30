// SPDX-License-Identifier: Apache-2.0

// Preflight check: branch-name
//
// Branch matches DESKTOP-<issue>/[<index>-]<slug>.

/** @type {import('../index.js').Check['id']} */
export const id = 'branch-name';

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

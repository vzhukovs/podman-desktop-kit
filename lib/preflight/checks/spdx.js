// SPDX-License-Identifier: Apache-2.0

// Preflight check: spdx
//
// Every added file carries the Apache-2.0 SPDX header.
//
// Shares checkSpdx() with the post-write hook so a file the hook accepted
// cannot fail here.

/** @type {import('../index.js').Check['id']} */
export const id = 'spdx';

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

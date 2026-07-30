// SPDX-License-Identifier: Apache-2.0

// Preflight check: r-coverage
//
// Every frozen R-ID is closed by a task and appears in the PR body.
//
// Skipped on the quickfix route, where tracing goes by issue number and no
// R-IDs exist. Skipped, not silently passed: the report says so.

/** @type {import('../index.js').Check['id']} */
export const id = 'r-coverage';

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

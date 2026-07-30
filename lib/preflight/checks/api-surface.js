// SPDX-License-Identifier: Apache-2.0

// Preflight check: api-surface
//
// Every new or changed exported type is grepped against extension-api.d.ts.
//
// This is the RunOptions trap as code. A type can sit in
// packages/main/src/plugin/util/exec.ts, look like an internal helper, and still
// be declared public in extension-api.d.ts. A grep settles it; a prompt does not.

/** @type {import('../index.js').Check['id']} */
export const id = 'api-surface';

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

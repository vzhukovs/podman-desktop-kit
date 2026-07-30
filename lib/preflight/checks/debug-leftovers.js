// SPDX-License-Identifier: Apache-2.0

// Preflight check: debug-leftovers
//
// console.log, .only, .skip, @ts-ignore, and any in the diff.
//
// Warns rather than blocks: each of these is occasionally legitimate, and a
// blocking rule for a judgement call teaches people to bypass the gate.

/** @type {import('../index.js').Check['id']} */
export const id = 'debug-leftovers';

/** @type {boolean} */
export const blocking = false;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

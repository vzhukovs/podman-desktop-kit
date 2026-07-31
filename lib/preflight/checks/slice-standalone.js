// SPDX-License-Identifier: Apache-2.0

// Preflight check: slice standalone
//
// `pdkit slice verify --standalone`: a slice that branches from main must build
// and pass on its own, because that is what a reviewer will see.
//
// Skipped, not passed, until stage 3 builds the slicer. A check that reports
// "pass" for work it did not do is how a gate stops meaning anything.

/** @type {string} */
export const id = 'slice-standalone';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  return {
    id,
    status: 'skip',
    blocking,
    summary: 'the slicer lands in stage 3; single-PR work has nothing to verify standalone',
  };
}

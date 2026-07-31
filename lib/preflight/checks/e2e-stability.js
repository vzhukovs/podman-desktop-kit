// SPDX-License-Identifier: Apache-2.0

// Preflight check: e2e stability
//
// A new test under tests/playwright has to pass validation.e2e_stability_runs
// times in a row before it can go anywhere. A flake carried into someone
// else's repository is the worst thing this workflow could deliver.
//
// Skipped until stage 5, where /pd:validate starts producing e2e tests. There
// is nothing to stabilize before something generates one.

/** @type {string} */
export const id = 'e2e-stability';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} _context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(_context) {
  return { id, status: 'skip', blocking, summary: 'e2e generation lands in stage 5' };
}

// SPDX-License-Identifier: Apache-2.0

// The preflight runner (spec section 7).
//
// Every check is its own module under checks/ with the same shape, so the set
// is enumerable and a check can be reasoned about — and disabled — in isolation.
// The report is machine-readable because the /pd:pr flow refuses to proceed on
// anything but a green result, and that decision must not depend on parsing
// prose.
//
// Blocking vs warning is a property of the check, not of the caller.

/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {'pass'|'fail'|'warn'|'skip'} status
 * @property {boolean} blocking
 * @property {string} summary
 * @property {string} [output]     raw command output where the check ran one
 * @property {string} [remedy]     what to do about it
 */

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {boolean} blocking
 * @property {(context: PreflightContext) => Promise<CheckResult>} run
 */

/**
 * @typedef {object} PreflightContext
 * @property {number} issue
 * @property {number} [slice]
 * @property {'quickfix'|'standard'|'multi-slice'|'redo'} route
 * @property {string} repoRoot
 * @property {string[]} changedFiles
 * @property {object} config
 */

/** Check ids in report order. Mirrors the table in section 7. */
export const CHECK_IDS = [
  'tests',
  'lint',
  'typecheck',
  'spdx',
  'conventional-commits',
  'signed-off-by',
  'schemas',
  'extension-api',
  'api-surface',
  'slice-standalone',
  'branch-name',
  'steps-to-check',
  'r-coverage',
  'e2e-stability',
  'e2e-environment',
  'debug-leftovers',
  'ci-blind-spots',
];

/**
 * Load every check module.
 *
 * @returns {Promise<Check[]>}
 */
export async function loadChecks() {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Run preflight and produce a report.
 *
 * Runs every check even after one fails: a report listing three problems is one
 * round trip, three reports of one problem each are three.
 *
 * @param {PreflightContext} _context
 * @returns {Promise<{ok: boolean, results: CheckResult[]}>}
 */
export async function run(_context) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

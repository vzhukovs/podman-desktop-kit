// SPDX-License-Identifier: Apache-2.0

// Allocation and freezing of R-IDs, task IDs, and slice IDs.
//
// R-IDs are allocated once and never renumbered. They trace requirement -> task
// -> commit -> the coverage table in the PR body. Renumbering breaks every link
// at once, so the freeze after plan approval is enforced here, not asked for in
// a prompt.
//
// On the quickfix route no R-IDs are allocated at all: tracing goes by issue
// number. When a quickfix escalates to standard, R-IDs are derived from the
// issue's requirements — never from the diff that already exists. IDs read off
// a finished diff describe what was built, not what was required, and the whole
// trace becomes self-confirming.

/**
 * Allocate the next free R-ID for an issue.
 *
 * @param {number} _issue
 * @returns {Promise<string>} e.g. "R4"
 * @throws when the requirement set is frozen
 */
export async function allocateRequirement(_issue) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Freeze the requirement set. Called on plan approval.
 *
 * @param {number} _issue
 * @returns {Promise<string[]>} the frozen IDs
 */
export async function freezeRequirements(_issue) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Allocate a task ID (T1, T2, ...) within an issue.
 *
 * @param {number} _issue
 * @returns {Promise<string>}
 */
export async function allocateTask(_issue) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Allocate a slice ID. Slices are numbered by merge order, starting at 1.
 *
 * @param {number} _issue
 * @returns {Promise<number>}
 */
export async function allocateSlice(_issue) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Branch name for a slice, per the `branches` config templates.
 *
 * @param {{issue: number, index?: number, slug: string}} _parts
 * @returns {string} e.g. "DESKTOP-12345/2-main-exec-plumbing"
 */
export function branchName(_parts) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

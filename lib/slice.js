// SPDX-License-Identifier: Apache-2.0

// Slicing one change set into N atomic pull requests (spec section 4).
//
// Two different graphs, and conflating them is the classic mistake:
//
//   file independence     slices do not share files. Checked mechanically.
//   symbol dependence     slice B references a symbol introduced by slice A.
//                         Invisible at the file level.
//
// Only one of these settles the question, and it is not an opinion:
// verifyStandalone() builds the slice alone, from main, in a scratch worktree.
// Green means the slice branches from main. Red means it needs a stack.

/**
 * @typedef {object} Slice
 * @property {number} index
 * @property {string} branch
 * @property {string[]} layers
 * @property {string} base            "main" or the branch of the preceding slice
 * @property {string[]} files
 * @property {string[]} requirements  R-IDs, empty on the quickfix route
 * @property {boolean|null} standalone
 * @property {boolean|null} revertsCleanly
 */

/**
 * Propose a slice graph from a diff plus the plan's slice hypothesis.
 *
 * Works from an arbitrary diff, not only local HEAD: upstream sometimes asks
 * for an already-open PR to be split, and that path uses the same slicer.
 *
 * @param {{diff: string, plan?: object, packageMap: object}} _input
 * @returns {Promise<Slice[]>}
 */
export async function propose(_input) {
  // TODO(stage 3)
  throw new Error('not implemented');
}

/**
 * Build a slice alone in a scratch worktree from main and run
 * typecheck, lint, and the scoped tests.
 *
 * @param {Slice} _slice
 * @returns {Promise<{ok: boolean, output: string}>}
 */
export async function verifyStandalone(_slice) {
  // TODO(stage 3)
  throw new Error('not implemented');
}

/**
 * Topological merge order for a slice graph.
 *
 * @param {Slice[]} _slices
 * @returns {number[]} slice indices in merge order
 */
export function mergeOrder(_slices) {
  // TODO(stage 3)
  throw new Error('not implemented');
}

/**
 * After a fix lands in a stacked slice, rebase everything downstream and
 * re-run verifyStandalone. Slices that stopped being standalone are flagged
 * rather than quietly re-based into a lie.
 *
 * @param {number} _issue
 * @param {number} _changedSlice
 * @returns {Promise<{rebased: number[], regressed: number[]}>}
 */
export async function cascade(_issue, _changedSlice) {
  // TODO(stage 4)
  throw new Error('not implemented');
}

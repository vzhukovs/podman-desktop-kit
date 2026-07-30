// SPDX-License-Identifier: Apache-2.0

// The global append-only journal.
//
// state.json knows WHERE we are. The journal knows WHY. "Why is slice #2 in a
// stack instead of branching from main" is recoverable six months later only
// from here.
//
// INVARIANT: append only. This module has no rewrite and no delete. Monthly
// files exist so `--since` does not read a year of history to answer a question
// about last week, and so the re-anchoring injection stays small.

/**
 * @typedef {object} Entry
 * @property {string} at      ISO 8601
 * @property {number|null} issue
 * @property {number|null} slice
 * @property {string} event
 * @property {string} detail
 */

/**
 * Append one entry. There is no counterpart that removes entries; that is the
 * point of the module.
 *
 * @param {Omit<Entry, 'at'>} _entry
 * @returns {Promise<void>}
 */
export async function append(_entry) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Read entries, filtered. The per-issue view is generated, never stored —
 * a stored copy is a second source of truth that drifts.
 *
 * @param {{issue?: number, since?: string, event?: string}} [_filter]
 * @returns {Promise<Entry[]>}
 */
export async function read(_filter) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Render the SessionStart re-anchoring summary: active issue, state, next step.
 * Deliberately not the whole journal — that would grow until it eats the
 * context it is meant to restore.
 *
 * @param {number} _issue
 * @returns {Promise<string>}
 */
export async function reanchor(_issue) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

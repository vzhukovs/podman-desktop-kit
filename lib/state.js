// SPDX-License-Identifier: Apache-2.0

// The issue state machine (spec section 1).
//
// INVARIANT: this module is the only writer of $PDKIT_HOME/issues/<n>/state.json.
// Skills and agents ask for a transition; they never edit the file. That is what
// makes "the gate only opens from preflight-green" a fact rather than a request.

/** @typedef {'new'|'triaged'|'quickfix'|'planned'|'plan-approved'|'implemented'|'validated'|'audited'|'sliced'|'slices-approved'|'preflight-green'|'pr-open'|'review-in-progress'|'merged'|'abandoned'} State */

/**
 * Allowed transitions. A transition absent from this table is not "unusual",
 * it is rejected — including transitions an agent is convinced are correct.
 *
 * @type {Record<State, State[]>}
 */
export const TRANSITIONS = {
  'new': ['triaged'],
  'triaged': ['quickfix', 'planned', 'abandoned'],
  'quickfix': ['preflight-green', 'triaged'],
  'planned': ['plan-approved', 'triaged'],
  'plan-approved': ['implemented'],
  'implemented': ['validated'],
  'validated': ['audited'],
  'audited': ['sliced'],
  'sliced': ['slices-approved'],
  'slices-approved': ['preflight-green'],
  'preflight-green': ['pr-open'],
  'pr-open': ['review-in-progress', 'merged', 'abandoned'],
  'review-in-progress': ['preflight-green', 'merged', 'abandoned'],
  'merged': [],
  'abandoned': [],
};

/** States from which a push gate may be issued at all. */
export const GATE_ELIGIBLE = ['preflight-green'];

/**
 * Read the state record for an issue.
 *
 * @param {number} _issue
 * @returns {Promise<{state: State, updatedAt: string, approvals: Record<string, string>, owns?: Record<string, string[]>}>}
 */
export async function read(_issue) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Attempt a transition. Rejects when the target is not reachable from the
 * current state, and appends the accepted move to the journal.
 *
 * @param {number} _issue
 * @param {State} _to
 * @param {{reason?: string, approvedBy?: string}} [_meta]
 * @returns {Promise<{ok: boolean, from: State, to: State, error?: string}>}
 */
export async function transition(_issue, _to, _meta) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Whether a transition is allowed, without performing it.
 *
 * @param {State} from
 * @param {State} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

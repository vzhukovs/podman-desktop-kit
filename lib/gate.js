// SPDX-License-Identifier: Apache-2.0

// Consent tokens for writes to GitHub.
//
// A token is issued for ONE branch, expires after a short TTL, and is spent on
// first use. Consent to push slice #1 is not consent to push slice #2, and
// consent given ten minutes ago is not consent now.
//
// The TTL is not a security measure — anyone can ask again. It exists so
// approval cannot be accumulated: a token you have to request in the moment is
// a token you are more likely to read the diff for.

/** Default lifetime of a token. Overridable via gates.push_ttl. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Issue a token for a branch.
 *
 * Refuses unless the issue is in a gate-eligible state (preflight-green) and
 * the branch appears in an approved slice graph. Both conditions are checked
 * here rather than trusted from the caller.
 *
 * @param {{issue: number, branch: string, ttlMs?: number}} _input
 * @returns {Promise<{token: string, expiresAt: string}>}
 */
export async function open(_input) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Check a token against a branch without spending it.
 *
 * @param {{branch: string, token?: string}} _input
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function verify(_input) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Spend a token. Idempotent: spending twice fails the second time, which is
 * the behaviour the push hook depends on.
 *
 * @param {string} _branch
 * @returns {Promise<void>}
 */
export async function close(_branch) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Drop every outstanding token. Used by doctor and on session start, so a
 * token cannot survive a crash into the next session.
 *
 * @returns {Promise<number>} how many were revoked
 */
export async function revokeAll() {
  // TODO(stage 1)
  throw new Error('not implemented');
}

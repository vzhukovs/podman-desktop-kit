// SPDX-License-Identifier: Apache-2.0

// PreToolUse handler for Write and Edit.
//
// The most valuable rule in the whole set. The plan gives every task exclusive
// ownership of its files; this turns that from a request into an invariant.
// Parallel workers then cannot collide by construction, which removes a class
// of merge conflicts rather than resolving them later.
//
// Files outside any task — the state directory, scratch notes — are not
// governed here. The rule applies inside the repository under work.

/**
 * @param {{tool_name?: string, tool_input?: {file_path?: string}}|null} payload
 * @param {{event: string, pluginRoot: string}} _context
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) return { block: false };

  // TODO(stage 2): read the active task from state.json, resolve its Owns
  // globs, and block when filePath falls outside. When no task is active,
  // allow: the constraint belongs to task execution, not to the session.
  throw new Error('not implemented');
}

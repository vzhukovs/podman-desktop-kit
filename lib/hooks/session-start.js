// SPDX-License-Identifier: Apache-2.0

// SessionStart and PreCompact handler.
//
// Both events answer the same question — "what was I doing?" — at opposite
// ends. SessionStart injects the answer; PreCompact writes it down before
// compaction can take it away. One module, branching on the event.
//
// The injected summary is deliberately small: active issue, state, next step.
// Injecting the journal itself would grow month over month until it consumed
// the context it exists to restore.

import { reanchor } from '../journal.js';

/**
 * @param {object|null} _payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision & {message?: string}>}
 */
export async function handle(_payload, context) {
  if (context.event === 'pre-compact') {
    // TODO(stage 0): flush active issue, state, and open questions to the
    // journal so the summary survives compaction.
    throw new Error('not implemented');
  }

  // TODO(stage 0): resolve the active issue and return the re-anchoring
  // summary as `message`. No active issue means no output at all — an empty
  // session should not start with plugin noise.
  void reanchor;
  throw new Error('not implemented');
}

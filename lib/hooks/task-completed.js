// SPDX-License-Identifier: Apache-2.0

// TaskCompleted handler: no receipt, no completion.
//
// "Done" means the output of the command from `Done when`, captured verbatim.
// Without this hook that rule is advice, and advice loses to a confident
// summary every time. With it, a task cannot be marked complete on narrative.

import { validateReceipt } from '../evidence.js';

/**
 * @param {{task_id?: string}|null} payload
 * @param {{event: string, pluginRoot: string}} _context
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const taskId = payload?.task_id;
  if (!taskId) return { block: false };

  // TODO(stage 2): require $PDKIT_HOME/issues/<n>/receipts/<taskId>.md and run
  // validateReceipt on it. Block with the exact command that still needs to be
  // run and captured.
  void validateReceipt;
  throw new Error('not implemented');
}

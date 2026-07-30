// SPDX-License-Identifier: Apache-2.0

// PreToolUse handler for every Bash call.
//
// One entry in hooks.json, all rules here. The matcher cannot see the command
// string (spec section 6), so this module parses it and decides.
//
// Rules live in a table rather than a chain of ifs so they can be enumerated,
// tested one by one, and read by someone deciding whether the gate is sound.

import { RULES } from './rules.js';

/**
 * @typedef {object} Decision
 * @property {boolean} block
 * @property {string} [reason]   shown to the model when blocking
 * @property {string} [rule]     which rule fired
 */

/**
 * Decide whether a Bash command may run.
 *
 * @param {{tool_name?: string, tool_input?: {command?: string}}|null} payload
 * @param {{event: string, pluginRoot: string}} _context
 * @returns {Promise<Decision>}
 */
export async function handle(payload, _context) {
  const commandLine = payload?.tool_input?.command;
  if (!commandLine) return { block: false };

  // TODO(stage 1): parse the line, evaluate RULES in order, and for gated
  // operations consult gate.verify() for the current branch. First matching
  // rule wins; a rule that allows also spends the gate token.
  void RULES;
  throw new Error('not implemented');
}

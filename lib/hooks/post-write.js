// SPDX-License-Identifier: Apache-2.0

// PostToolUse handler for Write and Edit.
//
// Two checks, both cheap and both catching things that otherwise surface in
// review:
//
//   1. A new source file without the SPDX header. Blocks with the exact text
//      to insert — a reminder without the text just costs another round trip.
//   2. A touched schema file. Marks state.json:schemas_dirty and reminds about
//      pnpm generate:schemas, because a stale generated schema fails CI long
//      after the change that caused it.

import { checkSpdx } from '../upstream.js';

/**
 * @param {{tool_name?: string, tool_input?: {file_path?: string}}|null} payload
 * @param {{event: string, pluginRoot: string}} _context
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) return { block: false };

  // TODO(stage 1): SPDX check for newly created files, schemas_dirty flag for
  // schema paths.
  void checkSpdx;
  throw new Error('not implemented');
}

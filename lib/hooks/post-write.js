/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// PostToolUse handler for Write and Edit.
//
// Two checks, both cheap and both catching things that otherwise surface in
// review:
//
//   1. A source file without the SPDX header. Blocks with the exact text to
//      insert — a reminder without the text just costs another round trip.
//   2. A touched schema file. Reminds about pnpm generate:schemas, because a
//      stale generated schema fails CI long after the change that caused it.
//
// Scoped to the repository under work, and that scoping is not optional. The
// header this enforces is podman-desktop's house format — a Red Hat copyright
// block — and this plugin's own sources use the one-line form. Without the
// guard, editing lib/*.js in this repository would demand a Red Hat header on
// files that must not carry one.

import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';

import { load } from '../config.js';
import { resolveRepoRoot } from '../repo.js';
import { SPDX_REQUIRED_EXTENSIONS, checkSpdx } from '../upstream.js';

/** Paths where a change means the generated schemas may be stale. */
const SCHEMA_PATH = /(^|\/)schemas\/|\.schema\.[a-z]+$/;

/**
 * Whether this path is worth a git round trip at all.
 *
 * PostToolUse fires on every write, so the cheap test comes first: most writes
 * are to files neither check has anything to say about.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function interesting(filePath) {
  return (
    SCHEMA_PATH.test(filePath) ||
    SPDX_REQUIRED_EXTENSIONS.some((extension) => filePath.endsWith(extension))
  );
}

/**
 * Look at a file that was just written, and say what it still needs.
 *
 * Runs after the write rather than before it, so it never stands between anyone
 * and their edit: what it produces is a reminder carrying the exact text to add,
 * not a refusal. The two things it looks for are the two that otherwise surface
 * in review, long after the context has gone.
 *
 * @param {{tool_name?: string, tool_input?: {file_path?: string}}|null} payload
 * @param {{event: string, pluginRoot: string}} [_context]
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const filePath = payload?.tool_input?.file_path;
  if (!filePath || !interesting(filePath)) return { block: false };

  // Only inside the repository being worked on. A different repository — this
  // plugin's own, a scratch checkout — has its own rules and none of ours.
  let inTargetRepo = false;
  try {
    const config = await load({});
    const repo = await resolveRepoRoot({ cwd: dirname(filePath), config });
    inTargetRepo = Boolean(repo.root) && repo.matches;
  } catch {
    return { block: false };
  }
  if (!inTargetRepo) return { block: false };

  if (SCHEMA_PATH.test(filePath)) {
    // A reminder, not a block. What actually guarantees the schemas are fresh
    // is preflight running the generator and diffing; this is here so the gap
    // between the change and finding out is minutes rather than a CI run in
    // somebody else's PR.
    return {
      block: false,
      message: `pdkit: ${filePath} affects the generated schemas — run \`pnpm generate:schemas\` and commit the result`,
    };
  }

  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return { block: false };
  }

  const spdx = checkSpdx({ path: filePath, content });
  if (!spdx.required || spdx.present) return { block: false };

  return {
    block: true,
    rule: 'spdx',
    reason:
      `pdkit: ${filePath} has no license header. Every source file in podman-desktop carries the ` +
      `Red Hat Apache block with the SPDX identifier inside it — a bare identifier line is not the ` +
      `repository's format. Insert this at the top of the file:\n\n${spdx.insert}`,
  };
}

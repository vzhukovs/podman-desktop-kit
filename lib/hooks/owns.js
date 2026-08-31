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

// PreToolUse handler for Write and Edit.
//
// The most valuable rule in the whole set. The plan gives every task exclusive
// ownership of its files; this turns that from a request into an invariant.
// Parallel workers then cannot collide by construction, which removes a class
// of merge conflicts rather than resolving them later.
//
// Three lookups, in the order that costs least: the file has to be inside a
// working tree, that tree has to have a task running in it, and the file has to
// be outside what that task owns. Most writes stop at the second.
//
// Files outside any task — the state directory, scratch notes, this plugin's
// own sources — are not governed here. The rule applies inside the tree where a
// planned task is running, and nowhere else.
//
// The deliberate hole: with no active task, everything is allowed. A worker
// started without `pdkit task start` gets no constraint at all. That is not
// closed here — a hook that guessed at ownership would block honest work — but
// by `pdkit audit`, which counts files changed outside every task's Owns set.
// The hook catches it in time; the audit catches it for certain.

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { current } from '../active.js';
import { matchesAny } from '../globs.js';
import { append } from '../journal.js';
import { relativeToRepo, worktreeRoot } from '../repo.js';
import { read as readState } from '../state.js';

/**
 * Decide whether this write is one the active task is allowed to make.
 *
 * Blocks only when a task is running AND the file is inside the repository AND
 * the plan gave it to somebody else. Everything outside that — no active task,
 * a file elsewhere on disk, an issue with no ownership map — is allowed, because
 * a hook that refuses what it does not understand stops the session rather than
 * the mistake.
 *
 * @param {{tool_name?: string, tool_input?: {file_path?: string}, cwd?: string}|null} payload
 * @param {{event: string, pluginRoot: string}} [_context]
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) return { block: false };

  // A relative path is resolved against the session's directory, which is what
  // the tool itself would do.
  const given = isAbsolute(filePath) ? filePath : resolve(payload?.cwd ?? process.cwd(), filePath);

  // Through the real path of the directory, not the path as written. git
  // reports the working tree with symlinks resolved (`/tmp` is a link to
  // `/private/tmp` on macOS, and repositories live behind links often enough),
  // so comparing a written path against it puts every file "outside the tree"
  // and quietly allows everything. The directory rather than the file itself:
  // a Write creates the file, so it need not exist yet.
  const directory = await realpath(dirname(given)).catch(() => dirname(given));
  const absolute = join(directory, basename(given));

  // The file's own directory, not the session's: an agent standing in the
  // plugin repository can still be asked to write into the fork.
  const worktree = await worktreeRoot(directory);
  if (!worktree) return { block: false };

  const active = await current({ worktree });
  if (!active) return { block: false };

  const record = await readState(active.issue);
  const owns = record.owns?.[active.taskId];

  // A task with no recorded ownership is a task nobody ran `pdkit task sync`
  // for. Blocking every write on it would make an unsynced plan look like a
  // broken tool, and the reason is worth saying out loud rather than deciding
  // silently either way.
  if (!Array.isArray(owns) || owns.length === 0) {
    return {
      block: false,
      message:
        `pdkit: ${active.taskId} of issue ${active.issue} has no recorded Owns set, so writes are not ` +
        `constrained. Run \`pdkit task sync --issue ${active.issue}\` to read it from the task files.`,
    };
  }

  const relative = relativeToRepo(worktree, absolute);

  // Outside the tree entirely — `../somewhere/else` — is not this task's
  // business and not this hook's either.
  if (relative.startsWith('../')) return { block: false };

  if (matchesAny(relative, owns)) return { block: false };

  // Refusals only, and never at the cost of the refusal itself — same reasoning
  // as the note in lib/hooks/dispatch.js. Without this a boundary that held and
  // a boundary that was never wired leave the same trace: none.
  try {
    await append({ issue: active.issue, event: 'denied', detail: `owns: ${active.taskId} may not write ${relative}` });
  } catch {
    // Nowhere useful to report from inside a hook, and the write is already
    // refused.
  }

  return {
    block: true,
    rule: 'owns',
    reason:
      `pdkit: ${relative} is not owned by ${active.taskId} (issue ${active.issue}).\n` +
      `  ${active.taskId} owns:\n${owns.map((entry) => `    ${entry}`).join('\n')}\n` +
      `  A task that needs a file outside its Owns set is a planning error, not a boundary to cross. ` +
      `Stop and report it: the plan gets amended, or the file belongs to another task that should ` +
      `make this change.`,
  };
}

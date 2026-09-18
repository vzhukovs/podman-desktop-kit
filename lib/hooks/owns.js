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
// An empty Owns set is not the same as a missing one, and this is the only
// place the difference is enforced. A missing entry is an unsynced plan and
// allows everything with a message; an entry that IS empty is a verification
// task — a whole-suite gate — and refuses everything, because writing nothing
// is what the plan said it does.
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

  // No entry at all is a task nobody ran `pdkit task sync` for. Blocking every
  // write on it would make an unsynced plan look like a broken tool, and the
  // reason is worth saying out loud rather than deciding silently either way.
  //
  // An entry that is an empty list is the opposite of that, and the difference
  // is the whole distinction: somebody did sync, and the plan's answer was that
  // this task owns nothing. Absent means unknown; `[]` means none.
  if (!Array.isArray(owns)) {
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

  // A task that owns nothing is a verification — a whole-suite gate, a
  // measurement — and a verification writes nothing by definition. Allowing the
  // write here would make the empty set the widest permission in the system
  // instead of the narrowest, which is the reading that lets a gate quietly
  // become an eighth implementer.
  if (owns.length === 0) {
    await note(active, relative);

    return {
      block: true,
      rule: 'owns',
      reason:
        `pdkit: ${active.taskId} of issue ${active.issue} owns no files — the plan has it as a verification, ` +
        `and a verification runs its \`Done when\` rather than writing anything.\n` +
        `  If ${active.taskId} is supposed to write ${relative}, the plan is wrong where it matters most: amend it, ` +
        `re-run \`pdkit task sync --issue ${active.issue}\`, and start the task again.`,
    };
  }

  if (matchesAny(relative, owns)) return { block: false };

  await note(active, relative);

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

/**
 * Record a refusal in the journal.
 *
 * Refusals only, and never at the cost of the refusal itself — same reasoning
 * as the note in lib/hooks/dispatch.js. Without this a boundary that held and a
 * boundary that was never wired leave the same trace: none.
 *
 * @param {{issue: number, taskId: string}} active
 * @param {string} relative
 * @returns {Promise<void>}
 */
async function note(active, relative) {
  try {
    await append({ issue: active.issue, event: 'denied', detail: `owns: ${active.taskId} may not write ${relative}` });
  } catch {
    // Nowhere useful to report from inside a hook, and the write is already
    // refused.
  }
}

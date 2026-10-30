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


import { resolveHome } from '../config.js';
import * as journal from '../journal.js';
import * as state from '../state.js';
import { EXIT, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'since', 'event', 'kind', 'file', 'resolution', 'commit', 'slice', 'amendment'];

/**
 * The one entry a person adds by hand: a conflict, resolved.
 *
 * Guarded by the issue being known to the machine. A mistyped number would
 * otherwise write a real entry under an issue that has no record, and the
 * journal is append-only — there is nothing that takes it back.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runJournalConflict(flags) {
  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit journal conflict: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const composed = journal.conflictEntry({
    kind: typeof flags.kind === 'string' ? flags.kind : '',
    file: typeof flags.file === 'string' ? flags.file : '',
    resolution: typeof flags.resolution === 'string' ? flags.resolution : '',
    commit: typeof flags.commit === 'string' ? flags.commit : null,
    amendment: typeof flags.amendment === 'string' ? flags.amendment : null,
  });

  if (!composed.ok) {
    process.stderr.write(`pdkit journal conflict: ${composed.error}\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const record = await state.read(issue, { home });
  if (record.history.length === 0) {
    process.stderr.write(
      `pdkit journal conflict: DESKTOP-${issue} is not in the machine — check the number, or start it with \`pdkit state ${issue} --to triaged\`\n`,
    );
    return EXIT.ERROR;
  }

  // Named for the module it must not shadow: `slice` at this scope is the
  // slicing module everywhere else in this file.
  const sliceIndex = flags.slice === undefined ? null : Number.parseInt(String(flags.slice), 10);
  if (sliceIndex !== null && !Number.isInteger(sliceIndex)) {
    process.stderr.write('pdkit journal conflict: --slice takes the slice number\n');
    return EXIT.ERROR;
  }

  const entry = await journal.append({ issue, slice: sliceIndex, event: composed.event, detail: composed.detail }, { home });

  if (flags.json) printJson(entry);
  else {
    process.stdout.write(`${journal.formatEntry(entry)}\n`);
    // Stated here rather than only in the skill: the entry is the record of a
    // decision, and a semantic conflict resolved without an amendment is the
    // plan quietly changing under the work it is meant to govern.
    if (composed.event === 'conflict-semantic' && typeof flags.amendment !== 'string') {
      process.stdout.write('  semantic, and no amendment cited — upstream rewrote what the plan stood on, so the plan is what has to move\n');
    }
  }

  return EXIT.OK;
}

/**
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  if (args[0] === 'conflict') return await runJournalConflict(flags);
  if (args.length > 0) {
    process.stderr.write(`pdkit journal: unknown action "${args[0]}" (conflict, or no action to read)\n`);
    return EXIT.ERROR;
  }

  const filter = {};
  if (flags.issue !== undefined) filter.issue = issueFlag(flags);
  if (typeof flags.since === 'string') {
    const since = journal.resolveSince(flags.since);
    if (!since.ok) {
      process.stderr.write(`pdkit journal: ${since.error}\n`);
      return EXIT.ERROR;
    }
    filter.since = since.at;
  }
  if (typeof flags.event === 'string') filter.event = flags.event;

  const entries = await journal.read(filter);

  if (flags.json) {
    printJson(entries);
    return EXIT.OK;
  }
  for (const entry of entries) process.stdout.write(`${journal.formatEntry(entry)}\n`);
  if (entries.length === 0) process.stdout.write('no entries\n');
  return EXIT.OK;
}

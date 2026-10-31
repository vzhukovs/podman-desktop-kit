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

// `pdkit state`: show a state record, or move the issue.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import * as blocks from '../blocks.js';
import { currentBranch, revision } from '../repo.js';
import * as state from '../state.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = ['to', 'route', 'reason', 'approved-by', 'slice'];

/**
 * Show a state record, or move the issue.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit state: an issue number is required\n');
    return EXIT.ERROR;
  }

  if (typeof flags.to === 'string') {
    // Where the caller is standing, resolved here rather than accepted as a
    // flag. Only `preflight-green` reads it, and the reason it is not an option
    // is the reason the state needed a guard at all: a value somebody can type
    // is a value somebody can type instead of earning.
    const standing = { head: /** @type {string|null} */ (null), branch: /** @type {string|null} */ (null) };
    if (flags.to === 'preflight-green') {
      const repo = await repoContext(flags);
      if (!repo.root) {
        process.stderr.write(
          `pdkit state: preflight-green is claimed about a commit, and there is no repository here — ${repo.problems.join('; ')}\n`,
        );
        return EXIT.ERROR;
      }
      standing.head = await revision('HEAD', { cwd: repo.root });
      standing.branch = await currentBranch({ cwd: repo.root });
    }

    const result = await state.transition(issue, /** @type {any} */ (flags.to), {
      reason: typeof flags.reason === 'string' ? flags.reason : undefined,
      approvedBy: typeof flags['approved-by'] === 'string' ? flags['approved-by'] : undefined,
      route: typeof flags.route === 'string' ? flags.route : undefined,
      slice: flags.slice === undefined ? null : Number.parseInt(String(flags.slice), 10),
      ...standing,
    });

    if (flags.json) printJson(result);
    if (!result.ok) {
      if (!flags.json) process.stderr.write(`pdkit state: ${result.error}\n`);
      return EXIT.ERROR;
    }
    if (!flags.json) {
      process.stdout.write(`issue ${issue}: ${result.from} -> ${result.to}\n`);
      // The line whose absence produced `/pd:implement`. What this used to print
      // was the state, and a state name is what gets typed as a command.
      const step = state.nextStep(/** @type {any} */ (result.record));
      if (step) process.stdout.write(`  next: ${step}\n`);
    }
    return EXIT.OK;
  }

  const record = await state.read(issue);
  if (flags.json) {
    printJson(record);
    return EXIT.OK;
  }

  const next = nextStates(record.state);
  const step = state.nextStep(record);
  const waiting = await blocks.open({ issue });
  process.stdout.write(
    `issue ${issue}\n` +
      `  state        : ${record.state}${record.createdAt ? '' : ' (nothing recorded yet)'}\n` +
      `  route        : ${record.route ?? '—'}\n` +
      `  requirements : ${record.requirements.ids.join(', ') || '—'}${record.requirements.frozen ? ' (frozen)' : ''}\n` +
      `  updated      : ${record.updatedAt ?? '—'}\n` +
      // Said here because everything downstream reads differently for an
      // adopted issue: no plan, no R-IDs and no receipts is what it looks like
      // when they were never produced, not when they went missing.
      (record.adopted
        ? `  adopted      : ${record.adopted.at.slice(0, 10)} at ${record.adopted.state ?? 'an earlier state'}` +
          `${record.adopted.pr ? `, #${record.adopted.pr}` : ''} — ${record.adopted.reason}\n` +
          // The state it was adopted AT, not the one it is in now: the record
          // moves on, and what stays true is which artefacts were never made.
          `                 the states before that were not passed; their artefacts do not exist\n`
        : '') +
      waiting.map((entry) => `  waits on     : #${entry.by} — ${entry.reason}\n`).join('') +
      `  next         : ${next}\n` +
      // The state and the command are two different answers, and only one of
      // them can be run. Printed as separate lines because folding them made
      // the state read like something to type — which is how `/pd:implement`
      // came to be typed.
      (step ? `  run          : ${step}\n` : ''),
  );
  return EXIT.OK;
}

/**
 * Where an issue in this state may go next. Printed with the record so the
 * answer to "what now" does not require opening the spec.
 *
 * @param {string} from
 * @returns {string}
 */
function nextStates(from) {
  const allowed = state.TRANSITIONS[from] ?? [];
  return allowed.length ? allowed.join(', ') : 'nothing — this state is terminal';
}

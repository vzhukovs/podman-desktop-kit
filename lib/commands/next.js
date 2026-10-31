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

// `pdkit next`: what to run next for an issue, as one line.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import * as blocks from '../blocks.js';
import { skillModel } from '../session-model.js';
import * as state from '../state.js';
import { EXIT } from './support.js';

export const flags = ['issue'];

/**
 * What to run next for an issue, as one line.
 *
 * The same answer `pdkit state` and the SessionStart summary give, without the
 * rest of either. It exists for the moment a phase has just ended in another
 * session: the next one opens empty, and a restart has to be cheaper than
 * carrying on not only in tokens but in effort — typing this beats remembering.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit next: an issue number is required\n');
    return EXIT.ERROR;
  }

  const record = await state.read(issue);
  const step = state.nextStep(record);

  // Said before the step, not instead of it: what does not depend on the
  // blocker can still move, and the step is how it does.
  for (const entry of await blocks.open({ issue })) {
    process.stdout.write(
      `waiting on #${entry.by} — ${entry.reason}\n` +
        `  once it has merged: pdkit issue unblock ${issue} --by ${entry.by}, then /pd:resume ${issue}\n`,
    );
  }

  // Null is an answer, not a gap — but an empty line is not one anybody can
  // read as "nothing follows", so it is said in words.
  if (!step) {
    process.stdout.write(`nothing — issue ${issue} is ${record.state}, and nothing follows from there\n`);
    return EXIT.OK;
  }

  // The model line goes first: the lines are copied top to bottom, and the
  // switch has to happen before the skill starts, not after.
  const skill = state.nextSkill(record);
  const model = skill ? await skillModel(skill) : null;
  if (model) process.stdout.write(`/model ${model}\n`);
  process.stdout.write(`${step}\n`);
  if (model) {
    process.stdout.write(
      `  a skill's model holds only until its turn ends, so the session carries the phase — advice, nothing checks it\n`,
    );
  }
  return EXIT.OK;
}

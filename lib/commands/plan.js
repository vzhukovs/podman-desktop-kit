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

// `pdkit plan`: the mechanical half of a plan review.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { checkPlan, parsePlan } from '../artefacts.js';
import { paths, resolveHome } from '../config.js';
import * as pr from '../pr.js';
import * as state from '../state.js';
import { EXIT, printJson } from './support.js';

export const flags = [];

/**
 * The mechanical half of a plan review.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  if (args[0] !== 'check') {
    process.stderr.write(`pdkit plan: unknown action "${args[0] ?? ''}" (check)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan check: an issue number is required\n');
    return EXIT.ERROR;
  }

  const path = join(paths(resolveHome()).issues, String(issue), 'plan.md');
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    process.stderr.write(`pdkit plan check: ${path} does not exist\n`);
    return EXIT.ERROR;
  }

  const record = await state.read(issue);
  const result = await checkPlan({ plan: parsePlan(content), content, record });

  // Which plan this verdict is about, and how old it is. `plan.md` is rendered
  // and then edited by hand, and a planning run that fails to persist leaves the
  // previous one in place — after which a green here is a statement about
  // yesterday that reads exactly like one about the plan just written. Measured
  // on 18832: a run whose every write was denied left the superseded plan on
  // disk, and this command reported `passes` for it without naming what it read.
  //
  // The same principle as the base ref in preflight (section 7) and `read:<age>`
  // on the dashboard (section 4): a measurement has to say what it saw. No
  // threshold and no warning — a plan is allowed to be old, and inventing a
  // staleness rule here would price a gate where there is no risk.
  const written = await stat(path)
    .then((entry) => pr.reading({ refreshedAt: entry.mtime.toISOString() }))
    .catch(() => null);

  if (flags.json) {
    printJson({ issue, path, writtenAt: written?.at ?? null, writtenAge: written?.label ?? null, ...result });
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  process.stdout.write(`plan check: issue ${issue} — ${result.ok ? 'passes' : `${result.problems.length} problem(s)`}\n`);
  if (written) {
    process.stdout.write(`  plan  ${path}, written ${written.label === 'just now' ? 'just now' : `${written.label} ago`}\n`);
  }
  for (const problem of result.problems) process.stdout.write(`  ✘ ${problem.check.padEnd(16)} ${problem.detail}\n`);
  for (const warning of result.warnings) process.stdout.write(`  ! ${warning.check.padEnd(16)} ${warning.detail}\n`);
  process.stdout.write(
    result.ok
      ? '\nThe mechanical checks pass. What is left is the question no grep answers:\nis this task necessary at all, and does something already do it?\n'
      : '\nThese get a plan redone rather than patched.\n',
  );

  return result.ok ? EXIT.OK : EXIT.ERROR;
}

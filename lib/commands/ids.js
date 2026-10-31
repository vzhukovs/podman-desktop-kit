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

// `pdkit ids`: allocate the next ID and spend it, or freeze the requirement
// set.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import * as ids from '../ids.js';
import { EXIT, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'slug', 'index'];

/**
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const [kind, rawIssue] = args;

  if (kind === 'branch') {
    const issue = issueFlag(flags);
    if (!Number.isInteger(issue) || typeof flags.slug !== 'string') {
      process.stderr.write('pdkit ids branch: --issue and --slug are required\n');
      return EXIT.ERROR;
    }
    const index = flags.index === undefined ? undefined : Number.parseInt(String(flags.index), 10);
    process.stdout.write(`${ids.branchName({ issue, slug: flags.slug, index })}\n`);
    return EXIT.OK;
  }

  const issue = Number.parseInt(rawIssue, 10);
  const handlers = {
    requirement: () => ids.allocateRequirement(issue),
    task: () => ids.allocateTask(issue),
    slice: () => ids.allocateSlice(issue),
    freeze: () => ids.freezeRequirements(issue),
  };

  const handler = Object.hasOwn(handlers, kind ?? '') ? handlers[kind] : null;
  if (!handler) {
    process.stderr.write(`pdkit ids: unknown kind "${kind ?? ''}" (requirement, task, slice, freeze, branch)\n`);
    return EXIT.ERROR;
  }

  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit ids: an issue number is required\n');
    return EXIT.ERROR;
  }

  try {
    const value = await handler();
    if (flags.json) printJson({ issue, kind, value });
    else process.stdout.write(`${Array.isArray(value) ? value.join(', ') || '—' : value}\n`);
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`pdkit ids: ${error.message}\n`);
    return EXIT.ERROR;
  }
}

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


import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { paths, resolveHome } from '../config.js';
import * as render from '../render.js';
import { EXIT, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'values'];

/**
 * Render the findings artefact for an issue whose deliverable is an answer.
 *
 * The count of captures is produced here rather than accepted as a value, for
 * the reason the `Standalone` column is produced rather than typed: a number
 * that says how much evidence there is must come from the evidence. Everything
 * else in the template is prose, because everything else is judgement.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  if (args[0] !== undefined && args[0] !== 'new') {
    process.stderr.write(`pdkit findings: unknown action "${args[0]}" (new)\n`);
    return EXIT.ERROR;
  }

  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit findings: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};

  const captures = await readdir(join(paths(home).issues, String(issue), 'validation')).catch(() => []);
  const captureCount = captures.filter((name) => name.endsWith('.md')).length;

  const path = await render.write({
    issue,
    template: 'findings',
    path: 'findings.md',
    home,
    values: {
      issue,
      answer: '<one line: what the answer is>',
      ...values,
      captureCount,
      writtenAt: new Date().toISOString(),
    },
  });

  if (flags.json) printJson({ path, captureCount });
  else {
    process.stdout.write(`${path}\n`);
    process.stdout.write(
      captureCount === 0
        ? '  nothing is attached yet — a workaround nobody ran is a suggestion, and this file would be publishing one\n'
        : `  ${captureCount} capture(s) attached. Publishing is yours: the hook denies \`gh issue comment\` from every state\n`,
    );
  }

  return EXIT.OK;
}

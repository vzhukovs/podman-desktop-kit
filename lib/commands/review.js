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

// `pdkit review`: facts about someone else's pull request, and the report they
// feed.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';

import { resolveHome } from '../config.js';
import { reveal } from '../reveal.js';
import * as review from '../review.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = ['pr', 'values', 'reveal'];

/**
 * Facts about someone else's pull request, and the report they feed.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const [subcommand] = args;
  const number = Number.parseInt(String(args[1] ?? flags.pr), 10);

  if (!Number.isInteger(number)) {
    process.stderr.write('pdkit review: a pull request number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);

  switch (subcommand) {
    case 'fetch': {
      if (!repo.root) {
        process.stderr.write(`pdkit review fetch: ${repo.problems.join('; ')}\n`);
        return EXIT.ERROR;
      }

      const report = await review.collect({ pr: number, repoRoot: repo.root, config: repo.config });
      if (flags.json) printJson(report);
      else process.stdout.write(review.format(report));
      // Always zero, for the same reason audit is: this reports, and an exit
      // code here would be a verdict the four axes have not reached yet.
      return EXIT.OK;
    }

    case 'render': {
      if (typeof flags.values !== 'string') {
        process.stderr.write('pdkit review render: --values <file.json> is required\n');
        return EXIT.ERROR;
      }

      const values = JSON.parse(await readFile(flags.values, 'utf8'));
      const written = await review.render({ pr: number, values, home: resolveHome({ repoRoot: repo.root ?? undefined }) });

      process.stdout.write(`${written.path}\n`);

      // The path is the answer; the window is a convenience. So it is asked
      // for, and a refusal to open is a note rather than a failure — the
      // report is written either way, and the exit code says so.
      if (flags.reveal) {
        const shown = await reveal(written.path);
        if (!shown.opened) process.stdout.write(`  (not opened: ${shown.reason})\n`);
      }

      return EXIT.OK;
    }

    default:
      process.stderr.write('pdkit review: fetch <k> | render <k> --values <file.json>\n');
      return EXIT.ERROR;
  }
}

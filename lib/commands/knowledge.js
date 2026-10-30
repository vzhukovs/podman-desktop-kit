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
import * as knowledge from '../knowledge.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = [];

/**
 * Revision of the shipped knowledge base.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });

  switch (args[0]) {
    case 'check': {
      const report = await knowledge.collect({ repoRoot: repo.root ?? null, config: repo.config, home });
      if (flags.json) printJson(report);
      else process.stdout.write(knowledge.format(report));
      // Zero even with findings: they are facts for a revision the user makes.
      return EXIT.OK;
    }

    case 'export': {
      const entries = await knowledge.exportEntries();
      if (flags.json) printJson(entries);
      else {
        for (const entry of entries) process.stdout.write(`${entry.name}\t${entry.title}\t${entry.sections.length} section(s)\n`);
        process.stdout.write(
          '\nThe bridge is one way (section 8): pdkit prints, the skill writes.\n' +
            'There is no import — a second source of truth would drift from these files.\n',
        );
      }
      return EXIT.OK;
    }

    default:
      process.stderr.write('pdkit knowledge: check | export\n');
      return EXIT.ERROR;
  }
}

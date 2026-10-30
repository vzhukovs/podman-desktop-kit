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


import { packageFor, readPackageMap } from '../repo.js';
import { EXIT, printJson } from './support.js';

export const flags = ['of'];

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  let map;
  try {
    map = await readPackageMap();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    process.stderr.write('pdkit packages: no package map yet — run `pdkit init`\n');
    return EXIT.ERROR;
  }

  if (typeof flags.of === 'string') {
    const owner = await packageFor(flags.of, { map });
    if (flags.json) printJson(owner);
    else if (owner) process.stdout.write(`${owner.name}  ${owner.path}  layer:${owner.layer}\n`);
    else process.stdout.write(`no package owns ${flags.of}\n`);
    return owner ? EXIT.OK : EXIT.ERROR;
  }

  if (flags.json) {
    printJson(map);
    return EXIT.OK;
  }

  for (const layer of map.layers) {
    const members = Object.entries(map.packages).filter(([, entry]) => entry.layer === layer);
    if (members.length === 0) continue;
    process.stdout.write(`${layer}\n`);
    for (const [name, entry] of members) process.stdout.write(`  ${name}  (${entry.path})\n`);
  }
  return EXIT.OK;
}

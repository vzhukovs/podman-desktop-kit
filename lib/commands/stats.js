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

// `pdkit stats`: what the guessed thresholds look like against the population
// they are about.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { load } from '../config.js';
import * as stats from '../stats.js';
import { EXIT, printJson } from './support.js';

export const flags = ['limit', 'author'];

/**
 * What the guessed thresholds look like against the population they are about.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  const report = await stats.collect({
    limit: typeof flags.limit === 'string' ? Number.parseInt(flags.limit, 10) : undefined,
    author: typeof flags.author === 'string' ? flags.author : undefined,
    config,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(stats.format(report));

  // Zero always: a distribution is not a pass or a fail, and an exit code here
  // would be the recommendation this command refuses to make.
  return EXIT.OK;
}

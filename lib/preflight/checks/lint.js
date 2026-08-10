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

// Preflight check: lint
//
// `pnpm lint:check`, not `pnpm lint` — the latter does not exist in
// podman-desktop, which is why the name is resolved rather than written down.

import { capture } from '../../evidence.js';
import { runScript } from '../scope.js';
import { pickScript } from '../../repo.js';

/** @type {string} */
export const id = 'lint';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const script = pickScript(context.scripts, ['lint:check', 'lint']);
  if (!script) {
    return { id, status: 'skip', blocking, summary: 'no lint script in this repository' };
  }

  const result = await capture({ command: runScript(context, script), cwd: context.repoRoot });
  const output = `$ ${result.command}\n${result.stdout}${result.stderr}`;

  if (result.exitCode !== 0 || !result.complete) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: result.incompleteBecause ?? `${script} failed`,
      output,
      remedy: `run \`${runScript(context, 'lint:fix')}\` for what is auto-fixable, then read the rest`,
    };
  }

  return { id, status: 'pass', blocking, summary: script, output };
}

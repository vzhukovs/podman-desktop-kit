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

// Preflight check: schemas
//
// Runs the generator and looks for a diff. This is the check that actually
// guarantees the committed schemas match their source — the post-write hook
// only reminds, and a reminder is not a guarantee.
//
// A stale generated schema fails CI long after the change that caused it,
// usually in somebody else's pull request, which is the kind of debt that is
// cheap to prevent and expensive to trace.

import { capture } from '../../evidence.js';
import { runScript } from '../scope.js';
import { pickScript } from '../../repo.js';

/** @type {string} */
export const id = 'schemas';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const script = pickScript(context.scripts, ['generate:schemas']);
  if (!script) return { id, status: 'skip', blocking, summary: 'no generate:schemas script in this repository' };

  // Only worth minutes of generator time when something could have changed it.
  // The generator builds packages/main, so anything under it counts, as does
  // the schemas directory itself.
  const relevant = context.changedFiles.filter(
    (file) => file.startsWith('schemas/') || file.startsWith('packages/main/'),
  );
  if (relevant.length === 0) {
    return { id, status: 'skip', blocking, summary: 'the diff touches neither schemas/ nor packages/main' };
  }

  const generated = await capture({ command: runScript(context, script), cwd: context.repoRoot });
  if (generated.exitCode !== 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${script} failed`,
      output: `$ ${generated.command}\n${generated.stdout}${generated.stderr}`,
    };
  }

  const diff = await capture({ command: 'git status --porcelain -- schemas/', cwd: context.repoRoot });
  if (diff.stdout.trim() !== '') {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'the generated schemas differ from what is committed',
      output: diff.stdout,
      remedy: `run \`${runScript(context, script)}\` and commit the result`,
    };
  }

  return { id, status: 'pass', blocking, summary: 'generated schemas match what is committed' };
}

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

// Preflight check: tests
//
// Runs the test script for each package the diff touches, resolved from the
// repository rather than hardcoded (see ../scope.js). Scoping matters here more
// than anywhere else: `pnpm test` in podman-desktop chains the e2e suite, which
// takes tens of minutes and is known to be flaky, so running it as a gate would
// make preflight something people skip.

import { capture } from '../../evidence.js';
import { covers, environmentFailure, passedInVerify, runScript, scopedScripts, unrunnable, verifiedRun } from '../scope.js';

/** @type {string} */
export const id = 'tests';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const scope = await scopedScripts(context, { verb: 'test', fallback: ['test:unit'] });

  if (scope.scripts.length === 0) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: 'no test script in this repository',
      remedy: 'add one to preflight.scripts.tests in the config, or check the package map is current',
    };
  }

  const verified = await verifiedRun(context);
  if (verified && covers(verified, scope.scripts)) return passedInVerify(id, blocking, scope.scripts, verified);

  const failures = [];
  const missing = [];
  const outputs = [];

  for (const script of scope.scripts) {
    const result = await capture({ command: runScript(context, script), cwd: context.repoRoot });
    outputs.push(`$ ${result.command}\n${result.stdout}${result.stderr}`);

    const reason = unrunnable(result, context);
    if (reason) missing.push(reason);
    else if (result.exitCode !== 0 || !result.complete) {
      failures.push(result.incompleteBecause ? `${script} (${result.incompleteBecause})` : script);
    }
  }

  const scoped = scope.usedFallback
    ? `${scope.scripts.join(', ')} (fallback${scope.unresolved.length ? `; no script for ${scope.unresolved.join(', ')}` : ''})`
    : scope.scripts.join(', ');

  // Said before any failure: a script that never started says nothing about
  // the code, and the remedy for the tests would send somebody the wrong way.
  if (missing.length > 0) return environmentFailure(id, blocking, missing, outputs.join('\n\n'), context);

  if (failures.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `failing: ${failures.join(', ')}`,
      output: outputs.join('\n\n'),
      remedy: 'fix the tests, or the code they are telling you about',
    };
  }

  return { id, status: 'pass', blocking, summary: scoped, output: outputs.join('\n\n') };
}

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

// Preflight check: typecheck
//
// The repository's whole `typecheck`, not the touched packages' own. This used
// to be scoped, to save the minutes the whole one walks through nine packages,
// and that saved exactly the check that mattered: a type error lands in the
// package that consumes a change, and on DESKTOP-19818 a preload-only slice
// passed here and went red on upstream CI in the renderer. See typecheckScripts.

import { capture } from '../../evidence.js';
import { runScript, typecheckScripts } from '../scope.js';

/** @type {string} */
export const id = 'typecheck';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const scope = await typecheckScripts(context);

  if (scope.scripts.length === 0) {
    return { id, status: 'skip', blocking, summary: 'no typecheck script in this repository' };
  }

  const failures = [];
  const outputs = [];

  for (const script of scope.scripts) {
    const result = await capture({ command: runScript(context, script), cwd: context.repoRoot });
    outputs.push(`$ ${result.command}\n${result.stdout}${result.stderr}`);
    if (result.exitCode !== 0 || !result.complete) failures.push(script);
  }

  if (failures.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `failing: ${failures.join(', ')}`,
      output: outputs.join('\n\n'),
    };
  }

  return {
    id,
    status: 'pass',
    blocking,
    summary: scope.whole
      ? `${scope.scripts.join(', ')} (whole repository)`
      : scope.usedFallback
        ? `${scope.scripts.join(', ')} (fallback)`
        : `${scope.scripts.join(', ')} (touched packages only — preflight.typecheck_scope)`,
    output: outputs.join('\n\n'),
  };
}

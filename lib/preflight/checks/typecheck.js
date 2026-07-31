// SPDX-License-Identifier: Apache-2.0

// Preflight check: typecheck
//
// Scoped to the packages the diff touches. The repository-wide `pnpm typecheck`
// walks nine packages in sequence, and a gate slow enough to skip is a gate
// that gets skipped.

import { capture } from '../../evidence.js';
import { runScript, scopedScripts } from '../scope.js';

/** @type {string} */
export const id = 'typecheck';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const scope = await scopedScripts(context, { verb: 'typecheck', fallback: ['typecheck'] });

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
    summary: scope.usedFallback ? `${scope.scripts.join(', ')} (fallback)` : scope.scripts.join(', '),
    output: outputs.join('\n\n'),
  };
}

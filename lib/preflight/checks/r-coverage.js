// SPDX-License-Identifier: Apache-2.0

// Preflight check: R-ID coverage
//
// Every frozen R-ID is mentioned in the PR body, so the trace from requirement
// to shipped change survives into the thing a reviewer reads.
//
// Skipped on the quickfix route, where tracing goes by issue number and no
// R-IDs exist. Skipped, not silently passed: the report says which it was.

import * as state from '../../state.js';

/** @type {string} */
export const id = 'r-coverage';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.route === 'quickfix') {
    return {
      id,
      status: 'skip',
      blocking,
      summary: 'quickfix route: tracing goes by issue number, no R-IDs are allocated',
    };
  }

  const record = await state.read(context.issue, { home: context.home });
  const ids = record.requirements.ids;

  if (ids.length === 0) {
    return { id, status: 'skip', blocking, summary: 'no requirements are recorded for this issue' };
  }
  if (!record.requirements.frozen) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'the requirement set is not frozen',
      remedy: 'requirements freeze on plan approval; pushing before that means the trace can still be renumbered under the PR',
    };
  }

  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: `${ids.length} frozen requirement${ids.length === 1 ? '' : 's'}; the PR body is not drafted yet`,
      remedy: 'draft the body, then run preflight again — this check has to read it',
    };
  }

  // Word boundaries: R1 must not be satisfied by R12.
  const missing = ids.filter((rid) => !new RegExp(`\\b${rid}\\b`).test(context.prBody));

  if (missing.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not mentioned in the PR body`,
      remedy: 'either the coverage table is incomplete, or this slice does not cover them and they belong to another one',
    };
  }

  return { id, status: 'pass', blocking, summary: `${ids.join(', ')} all covered` };
}

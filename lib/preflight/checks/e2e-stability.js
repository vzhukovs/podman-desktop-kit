// SPDX-License-Identifier: Apache-2.0

// Preflight check: e2e stability
//
// A new test under tests/playwright has to pass validation.e2e_stability_runs
// times in a row before it can go anywhere. A flake carried into someone
// else's repository is the worst thing this workflow could deliver.
//
// The freshness of that series matters as much as the series itself. Three
// green runs against a spec that has since been edited prove nothing about the
// spec being shipped — the same stale proof the slice diff digest exists to
// catch, and the same answer: a stale series is a `fail` asking for a re-run,
// never a `pass`.

import { get } from '../../config.js';
import { read, seriesFreshness } from '../../validation.js';

/** @type {string} */
export const id = 'e2e-stability';

/** @type {boolean} */
export const blocking = true;

/** Where e2e tests live in this repository. */
const E2E = /(^|\/)tests\/playwright\/.*\.spec\.[cm]?ts$/;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const added = context.changed.filter((entry) => entry.status !== 'D' && E2E.test(entry.path)).map((entry) => entry.path);

  if (added.length === 0) {
    return { id, status: 'pass', blocking, summary: 'no e2e test in this diff' };
  }

  const wanted = Number(get(context.config, 'validation.e2e_stability_runs') ?? 3);
  const record = await read(context.issue, { home: context.home });

  if (!record?.e2e.spec) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${added.length} e2e test(s) in the diff, and no series was recorded for any of them`,
      output: added.join('\n'),
      remedy: `pdkit validate codify --issue ${context.issue} --spec <path>, then pdkit e2e stability --issue ${context.issue}`,
    };
  }

  // The diff can carry a test the series never measured. Reporting the series
  // as covering it would be this check answering about a different file.
  if (!added.includes(record.e2e.spec)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the recorded series is for ${record.e2e.spec}, which is not what this diff adds`,
      output: added.join('\n'),
      remedy: `run the series for the test being shipped: pdkit e2e stability --issue ${context.issue}`,
    };
  }

  const fresh = await seriesFreshness({ issue: context.issue, home: context.home, repoRoot: context.repoRoot, record });
  if (!fresh.fresh) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: fresh.reason,
      remedy: `the runs describe an older version of the test; re-run pdkit e2e stability --issue ${context.issue}`,
    };
  }

  if (record.e2e.consecutive < wanted) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${record.e2e.consecutive} of ${wanted} consecutive green runs`,
      output: record.e2e.runs.map((entry) => `${entry.at} exit ${entry.exitCode ?? 'killed'} — ${entry.evidence}`).join('\n'),
      remedy: `pdkit e2e stability --issue ${context.issue} --runs ${wanted}`,
    };
  }

  return {
    id,
    status: 'pass',
    blocking,
    summary: `${record.e2e.spec} passed ${record.e2e.consecutive} times in a row`,
  };
}

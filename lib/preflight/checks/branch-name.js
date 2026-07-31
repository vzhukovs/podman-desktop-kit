// SPDX-License-Identifier: Apache-2.0

// Preflight check: branch name
//
// The branch matches DESKTOP-<issue>/[<index>-]<slug> and names the issue
// being worked on. The pattern comes from lib/ids.js, where branchName also
// reads it: two copies would mean a generator that produces branches its own
// gate rejects.

import { BRANCH_PATTERN, parseBranch } from '../../ids.js';

/** @type {string} */
export const id = 'branch-name';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (!context.branch) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'HEAD is detached, so there is no branch to push',
      remedy: 'check out a branch named DESKTOP-<issue>/<slug>',
    };
  }

  const parts = parseBranch(context.branch);
  if (!parts) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `"${context.branch}" does not match ${BRANCH_PATTERN.source}`,
      remedy: `rename it: git branch -m DESKTOP-${context.issue}/<slug>, lower case and dashes`,
    };
  }

  if (parts.issue !== context.issue) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the branch names issue ${parts.issue}, but this run is for ${context.issue}`,
      remedy: 'one of the two is wrong, and pushing before finding out which is how work lands on the wrong issue',
    };
  }

  return { id, status: 'pass', blocking, summary: context.branch };
}

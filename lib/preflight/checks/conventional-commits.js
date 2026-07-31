// SPDX-License-Identifier: Apache-2.0

// Preflight check: conventional commits
//
// Every commit on the branch parses and uses a type commitlint accepts.
//
// The scope is NOT required, and this is the check where that matters. Upstream
// runs plain config-conventional, CONTRIBUTING writes the format as
// `<type>[optional scope]`, and scope-less subjects land on main every week.
// Blocking on a missing scope would reject valid work — so it is reported as a
// note and the check still passes.

import { validateCommit } from '../../upstream.js';

/** @type {string} */
export const id = 'conventional-commits';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.commits.length === 0) {
    return { id, status: 'skip', blocking, summary: `no commits on ${context.branch ?? 'this branch'} yet` };
  }

  const problems = [];
  const notes = [];

  for (const commit of context.commits) {
    const result = validateCommit(commit);
    const short = commit.sha.slice(0, 8);

    // Sign-off is its own check; only the subject is this one's business.
    for (const problem of result.problems.filter((text) => !text.includes('Signed-off-by'))) {
      problems.push(`${short} ${problem}`);
    }
    for (const note of result.notes) notes.push(`${short} ${note}`);
  }

  if (problems.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${problems.length} commit subject${problems.length === 1 ? '' : 's'} the husky hook would reject`,
      output: problems.join('\n'),
      remedy: 'reword with git reset --soft <base> && git commit — not rebase -i, which the sign-off hook rejects',
    };
  }

  return {
    id,
    status: 'pass',
    blocking,
    summary: `${context.commits.length} commit${context.commits.length === 1 ? '' : 's'} well formed`,
    ...(notes.length > 0 ? { output: notes.join('\n'), remedy: 'a package scope is optional upstream but tells a reviewer which area to look at' } : {}),
  };
}

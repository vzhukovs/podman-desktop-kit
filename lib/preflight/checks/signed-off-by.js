// SPDX-License-Identifier: Apache-2.0

// Preflight check: Signed-off-by
//
// Exactly one trailer per commit. Both failures are real: none means the DCO
// check fails, and two means .husky/commit-msg rejects the message outright.
//
// Two is the one that surprises people, because it is what `git rebase -i`
// produces when squashing commits that each already carry a sign-off — the
// hook appends the trailer to a message that has one and then refuses what it
// just created.

/** @type {string} */
export const id = 'signed-off-by';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.commits.length === 0) {
    return { id, status: 'skip', blocking, summary: 'no commits on this branch yet' };
  }

  const problems = [];

  for (const commit of context.commits) {
    const count = (commit.trailers?.['Signed-off-by'] ?? []).length;
    if (count === 1) continue;

    problems.push(
      count === 0
        ? `${commit.sha.slice(0, 8)} has no Signed-off-by`
        : `${commit.sha.slice(0, 8)} has ${count} Signed-off-by trailers`,
    );
  }

  if (problems.length > 0) {
    const duplicates = problems.some((text) => text.includes('trailers'));
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${problems.length} commit${problems.length === 1 ? '' : 's'} with the wrong number of sign-offs`,
      output: problems.join('\n'),
      remedy: duplicates
        ? 'this is what rebase -i produces when squashing signed commits — redo the squash with git reset --soft <base> && git commit'
        : 'commit with -s, or let the husky hook add it',
    };
  }

  return { id, status: 'pass', blocking, summary: `exactly one sign-off on each of ${context.commits.length}` };
}

// SPDX-License-Identifier: Apache-2.0

// The deny rules of section 6, as data.
//
// Each rule states the command it recognizes, what it does, and — for the ones
// that deny — a message that tells the model what to do instead. A deny with no
// alternative just gets retried in a slightly different shape.

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} program
 * @property {string[]} argPrefix
 * @property {'deny'|'gate'} action    deny: always. gate: allow only with a valid token
 * @property {(cmd: import('./command-parse.js').ParsedCommand) => boolean} [when]
 * @property {string} reason
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'force-push-without-lease',
    program: 'git',
    argPrefix: ['push'],
    action: 'deny',
    // Narrower than the gate rule below and therefore listed first: --force
    // without --force-with-lease is refused even when a valid token exists.
    reason:
      'git push --force is never allowed. Use --force-with-lease, and only on your own branch.',
  },
  {
    id: 'push',
    program: 'git',
    argPrefix: ['push'],
    action: 'gate',
    reason:
      'No consent token for this branch. Run the /pd:pr flow: it shows the PR body and the exact commands, then issues a token valid for one branch and ten minutes.',
  },
  {
    id: 'gh-pr-write',
    program: 'gh',
    argPrefix: ['pr'],
    action: 'gate',
    reason: 'Writing a pull request requires a consent token for the head branch.',
  },
  {
    id: 'gh-issue-comment',
    program: 'gh',
    argPrefix: ['issue', 'comment'],
    action: 'gate',
    reason:
      'Commenting on an upstream issue requires explicit consent. Drafts are fine; publishing is a human action.',
  },
  {
    id: 'gh-api-write',
    program: 'gh',
    argPrefix: ['api'],
    action: 'gate',
    reason: 'gh api with a mutating method requires a consent token.',
  },
  {
    id: 'add-all',
    program: 'git',
    argPrefix: ['add'],
    action: 'deny',
    reason:
      'git add -A and git add . stage whatever happens to be in the tree. List the paths explicitly.',
  },
  {
    id: 'interactive-rebase',
    program: 'git',
    argPrefix: ['rebase'],
    action: 'deny',
    reason:
      'git rebase -i does not survive the Husky commit-msg hook: it appends Signed-off-by and then rejects the duplicate. Squash with git reset --soft <base> && git commit.',
  },
  {
    id: 'no-verify',
    program: 'git',
    argPrefix: ['commit'],
    action: 'deny',
    reason:
      '--no-verify skips the hooks that add Signed-off-by and check the commit message. Fix the commit instead.',
  },
];

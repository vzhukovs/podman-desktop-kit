// SPDX-License-Identifier: Apache-2.0

// The deny rules of section 6, as data.
//
// Each rule states the command it recognizes, what it does, and — for the ones
// that deny — a message that tells the model what to do instead. A deny with no
// alternative just gets retried in a slightly different shape.
//
// A rule matches on three things: the program, a prefix of its arguments, and
// an optional predicate. The predicate is what keeps a rule from swallowing the
// ordinary case: `git commit` is not `git commit --no-verify`, and a rule that
// cannot tell them apart gets the whole gate switched off within a day.

import { hasFlag, optionValue, parse } from './command-parse.js';

/** `gh pr <sub>` subcommands that write. Everything else is a read. */
const GH_PR_WRITE = [
  'create',
  'edit',
  'merge',
  'review',
  'close',
  'reopen',
  'ready',
  'comment',
  'lock',
  'unlock',
];

/** `gh issue <sub>` subcommands that write, other than `comment`. */
const GH_ISSUE_WRITE = [
  'create',
  'edit',
  'close',
  'reopen',
  'delete',
  'transfer',
  'pin',
  'unpin',
  'lock',
  'unlock',
];

/** HTTP methods that cannot change anything. */
const READ_METHODS = ['GET', 'HEAD'];

/** Options that put a field in the request body, which implies a write. */
const BODY_OPTIONS = ['-f', '-F', '--field', '--raw-field', '--input'];

/** A cluster of short options and nothing else: `-f`, `-fu`, `-Av`. */
const SHORT_CLUSTER = /^-[A-Za-z]+$/;

/**
 * Whether a short option is present, including inside a cluster: `-f` matches
 * both `git push -f` and `git push -fu`.
 *
 * Two exclusions, both deliberate. Long options are not clusters —
 * `--follow-tags` contains an "f" and is not `-f`. And the cluster must be
 * letters only, so an argument that merely begins with a dash — a commit
 * message like `-n days later` — is not read as a flag. Quoting is invisible
 * at this level, so the shape of the token is all there is to go on.
 *
 * @param {import('./command-parse.js').ParsedCommand} command
 * @param {string} letter
 * @returns {boolean}
 */
function hasShortFlag(command, letter) {
  return command.args.some((arg) => SHORT_CLUSTER.test(arg) && arg.slice(1).includes(letter));
}

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
    //
    // There is no "and not --force-with-lease" clause here, and that is not an
    // omission. hasFlag matches exactly, so --force never fires on
    // --force-with-lease. What the missing clause buys is the case where both
    // are written: in git, a later --force overrides an earlier lease, so a
    // line carrying both is a real force push and is refused.
    when: (command) => hasFlag(command, '--force') || hasShortFlag(command, 'f'),
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
    when: (command) => GH_PR_WRITE.includes(command.args[1]),
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
    id: 'gh-issue-write',
    program: 'gh',
    argPrefix: ['issue'],
    action: 'gate',
    when: (command) => GH_ISSUE_WRITE.includes(command.args[1]),
    reason:
      'Creating or changing an upstream issue is a write to someone else’s tracker. Draft it, show it, and let a human publish.',
  },
  {
    id: 'gh-api-write',
    program: 'gh',
    argPrefix: ['api'],
    action: 'gate',
    // Three shapes of write, and one read that looks exactly like a write.
    // `gh api graphql` is always an HTTP POST, but GraphQL says what it is in
    // the document: reading review threads is a query, resolving one is a
    // mutation. Gating every graphql call would gate the read paths that
    // /pd:pr-sync is built on.
    when: (command) => {
      const method = optionValue(command, ['-X', '--method']);
      if (method && !READ_METHODS.includes(method.toUpperCase())) return true;

      if (command.args.includes('graphql')) {
        return command.args.some((arg) => /\bmutation\b/.test(arg));
      }

      return command.args.some((arg) => BODY_OPTIONS.includes(arg));
    },
    reason: 'gh api with a mutating method requires a consent token.',
  },
  {
    id: 'add-all',
    program: 'git',
    argPrefix: ['add'],
    action: 'deny',
    when: (command) =>
      command.args.some((arg) => arg === '-A' || arg === '--all' || arg === '.' || arg === ':/') ||
      hasShortFlag(command, 'A'),
    reason:
      'git add -A and git add . stage whatever happens to be in the tree. List the paths explicitly.',
  },
  {
    id: 'interactive-rebase',
    program: 'git',
    argPrefix: ['rebase'],
    action: 'deny',
    when: (command) =>
      hasFlag(command, '--interactive') || hasShortFlag(command, 'i'),
    reason:
      'git rebase -i does not survive the Husky commit-msg hook: it appends Signed-off-by and then rejects the duplicate. Squash with git reset --soft <base> && git commit.',
  },
  {
    id: 'no-verify',
    program: 'git',
    argPrefix: ['commit'],
    action: 'deny',
    // -n is the short form of --no-verify for commit. For push it means
    // --dry-run instead, which is why this rule is scoped to commit.
    when: (command) => hasFlag(command, '--no-verify') || hasShortFlag(command, 'n'),
    reason:
      '--no-verify skips the hooks that add Signed-off-by and check the commit message. Fix the commit instead.',
  },
];

/**
 * Whether one parsed command matches one rule.
 *
 * @param {Rule} rule
 * @param {import('./command-parse.js').ParsedCommand} command
 * @returns {boolean}
 */
export function matchesRule(rule, command) {
  if (command.program !== rule.program) return false;
  if (!rule.argPrefix.every((value, index) => command.args[index] === value)) return false;
  return rule.when ? rule.when(command) : true;
}

/**
 * First rule that any command in the line trips.
 *
 * Commands are examined in the order they would run, and the rules in the order
 * they are declared — so a --force push is caught by the unconditional refusal
 * before it reaches the gate, which is what the ordering in RULES is for.
 *
 * Rule evaluation lives here rather than in dispatch.js so it can be tested
 * without a gate, a state directory, or a hook payload. What dispatch adds is
 * the consent token, not the decision about which rule applies.
 *
 * @param {string} commandLine
 * @returns {{rule: Rule, command: import('./command-parse.js').ParsedCommand}|null}
 */
export function select(commandLine) {
  for (const command of parse(commandLine)) {
    for (const rule of RULES) {
      if (matchesRule(rule, command)) return { rule, command };
    }
  }
  return null;
}

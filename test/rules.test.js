// SPDX-License-Identifier: Apache-2.0

// Tests for lib/hooks/rules.js.
//
// The rules are data, which makes their structure checkable now, before the
// dispatcher that consumes them exists. Two properties here are load-bearing
// rather than cosmetic: rule order, and the presence of a remedy in every deny
// message.
//
// Not in the planned file list — added because the ordering property below has
// no other place to be asserted, and getting it wrong silently weakens the
// force-push rule.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RULES, select } from '../lib/hooks/rules.js';

/** The rule a command line trips, or null. */
const fired = (line) => select(line)?.rule.id ?? null;

describe('rule shape', () => {
  test('ids are unique', () => {
    const ids = RULES.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every rule is complete', () => {
    for (const rule of RULES) {
      assert.ok(rule.id, 'missing id');
      assert.ok(rule.program, `${rule.id}: missing program`);
      assert.ok(Array.isArray(rule.argPrefix), `${rule.id}: argPrefix must be an array`);
      assert.ok(['deny', 'gate'].includes(rule.action), `${rule.id}: bad action`);
      assert.ok(rule.reason, `${rule.id}: missing reason`);
    }
  });

  // A deny that only says no gets retried in a slightly different shape. Every
  // refusal has to point somewhere.
  test('every deny message says what to do instead', () => {
    for (const rule of RULES.filter((r) => r.action === 'deny')) {
      assert.ok(
        rule.reason.length > 40,
        `${rule.id}: reason is too short to contain an alternative`,
      );
    }
  });
});

describe('rule order', () => {
  // First match wins, so the narrower rule has to come first. Reversed, a valid
  // gate token would let a --force push through, which is the one thing that is
  // refused unconditionally.
  test('force-push is checked before the general push gate', () => {
    const force = RULES.findIndex((rule) => rule.id === 'force-push-without-lease');
    const push = RULES.findIndex((rule) => rule.id === 'push');
    assert.ok(force !== -1 && push !== -1, 'both rules must exist');
    assert.ok(force < push, 'force-push rule must precede the push gate rule');
  });
});

describe('coverage of section 6', () => {
  const required = [
    'force-push-without-lease',
    'push',
    'gh-pr-write',
    'gh-issue-comment',
    'gh-api-write',
    'add-all',
    'interactive-rebase',
    'no-verify',
  ];

  for (const id of required) {
    test(`${id} is present`, () => {
      assert.ok(
        RULES.some((rule) => rule.id === id),
        `rule "${id}" from spec section 6 is missing`,
      );
    });
  }

  // Gated or denied outright — never allowed. Denying is the stronger answer
  // and belongs to the writes no state in section 1 authorises at all: nothing
  // in this workflow has pdkit posting to someone else's tracker.
  test('every GitHub write is gated or denied, never a bare allow', () => {
    for (const rule of RULES.filter((r) => r.program === 'gh')) {
      assert.ok(['gate', 'deny'].includes(rule.action), `${rule.id}: gh writes must not be allowed`);
    }
  });

  // Consent to publish code is not consent to speak in a review. Before the
  // token had a kind, the push token for whatever branch you happened to be
  // standing on authorised every one of these.
  test('a write to an open pull request asks for a reply token, not a push token', () => {
    const kindOf = (id) => RULES.find((rule) => rule.id === id)?.gate ?? 'push';

    assert.equal(kindOf('push'), 'push');
    assert.equal(kindOf('gh-pr-create'), 'push');
    assert.equal(kindOf('gh-pr-write'), 'reply');
    assert.equal(kindOf('gh-api-write'), 'reply');
  });
});

// Every rule gets a pair: the command it must catch, and the neighbouring one
// it must not. A one-sided test is what let the rules ship matching everything
// — the shape and order assertions above all passed while force-push-without-
// lease was refusing every `git push` and no-verify every `git commit`.
describe('selectivity', () => {
  test('force push is refused, an ordinary and a leased push are not', () => {
    assert.equal(fired('git push --force origin main'), 'force-push-without-lease');
    assert.equal(fired('git push -f origin main'), 'force-push-without-lease');
    assert.equal(fired('git push -fu origin main'), 'force-push-without-lease');
    // Written together, a later --force overrides the lease: still a force push.
    assert.equal(fired('git push --force-with-lease --force'), 'force-push-without-lease');

    assert.equal(fired('git push origin main'), 'push');
    assert.equal(fired('git push --force-with-lease origin main'), 'push');
    assert.equal(fired('git push --follow-tags origin main'), 'push');
  });

  test('gh pr writes are gated, gh pr reads are not', () => {
    assert.equal(fired('gh pr create --base main --head x'), 'gh-pr-create');
    assert.equal(fired('gh pr merge 12'), 'gh-pr-write');
    assert.equal(fired('gh pr review 12 --approve'), 'gh-pr-write');

    assert.equal(fired('gh pr view 12'), null);
    assert.equal(fired('gh pr list --state open'), null);
    assert.equal(fired('gh pr diff 12'), null);
    assert.equal(fired('gh pr checks 12'), null);
  });

  test('gh issue writes are gated, gh issue reads are not', () => {
    assert.equal(fired('gh issue comment 12 --body hello'), 'gh-issue-comment');
    assert.equal(fired('gh issue create --title x'), 'gh-issue-write');
    assert.equal(fired('gh issue close 12'), 'gh-issue-write');

    assert.equal(fired('gh issue view 12'), null);
    assert.equal(fired('gh issue list --label bug'), null);
  });

  test('gh api is gated by method and body, not by name', () => {
    assert.equal(fired('gh api -X POST repos/o/r/issues'), 'gh-api-write');
    assert.equal(fired('gh api --method=PATCH repos/o/r/issues/1'), 'gh-api-write');
    assert.equal(fired('gh api repos/o/r/issues -f title=x'), 'gh-api-write');

    assert.equal(fired('gh api repos/o/r/issues/1'), null);
    assert.equal(fired('gh api -X GET repos/o/r'), null);
  });

  // gh api graphql is always an HTTP POST. Gating it on the method would gate
  // the thread reads that /pd:pr-sync is built on; the document says which it
  // is.
  test('a graphql query reads, a graphql mutation writes', () => {
    assert.equal(fired("gh api graphql -f query='query { repository { id } }'"), null);
    assert.equal(
      fired("gh api graphql -f query='mutation { resolveReviewThread(input: {}) { thread { id } } }'"),
      'gh-api-write',
    );
  });

  test('git add refuses the blanket forms and allows explicit paths', () => {
    assert.equal(fired('git add -A'), 'add-all');
    assert.equal(fired('git add .'), 'add-all');
    assert.equal(fired('git add --all'), 'add-all');

    assert.equal(fired('git add packages/main/src/x.ts'), null);
    assert.equal(fired('git add ./packages/main/src/x.ts'), null);
    assert.equal(fired('git add -p packages/main/src/x.ts'), null);
  });

  test('only an interactive rebase is refused', () => {
    assert.equal(fired('git rebase -i HEAD~3'), 'interactive-rebase');
    assert.equal(fired('git rebase --interactive main'), 'interactive-rebase');

    assert.equal(fired('git rebase main'), null);
    assert.equal(fired('git rebase --continue'), null);
    assert.equal(fired('git rebase --abort'), null);
  });

  test('only a commit skipping hooks is refused', () => {
    assert.equal(fired('git commit --no-verify -m x'), 'no-verify');
    // -n is the short form of --no-verify for commit.
    assert.equal(fired('git commit -n -m x'), 'no-verify');

    assert.equal(fired('git commit -m x'), null);
    assert.equal(fired('git commit -am x'), null);
    assert.equal(fired('git commit --amend --no-edit'), null);
    // A message that merely starts with a dash is not a flag.
    assert.equal(fired('git commit -m "-n days later this broke"'), null);
  });

  // The whole point of the predicates: everyday work must pass untouched, or
  // the gate gets disabled and takes the rest of the rules with it.
  test('ordinary work trips nothing', () => {
    for (const line of [
      'git status',
      'git diff --stat',
      'git log --oneline -20',
      'git checkout -b DESKTOP-1/x',
      'git reset --soft main',
      'pnpm lint:check',
      'pnpm test:unit',
      'gh auth status',
      'gh repo view',
      'git commit -m "fix(main): guard the empty case"',
    ]) {
      assert.equal(fired(line), null, `${line} must not trip a rule`);
    }
  });

  test('a rule fires through a wrapper and through a chain', () => {
    assert.equal(fired('rtk git push origin main'), 'push');
    assert.equal(fired('pnpm test:unit && git push'), 'push');
    assert.equal(fired('(git add -A)'), 'add-all');
  });
});

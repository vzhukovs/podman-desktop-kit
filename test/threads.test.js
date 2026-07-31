// SPDX-License-Identifier: Apache-2.0

// Tests for lib/threads.js.
//
// The asymmetry is what these are mostly about. Collapsing a bot is cheap to
// get wrong in a way nobody notices: a security finding that failed to contain
// a configured word, dropped silently, looks exactly like a quiet review.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as threads from '../lib/threads.js';
import * as slice from '../lib/slice.js';
import { setOwns, transition } from '../lib/state.js';

const ISSUE = 7202;
const CONFIG = {
  review: { bots_collapsed: ['coderabbitai'], bot_escalate: ['security', 'data-loss', 'correctness'] },
  branches: { sliced: 'DESKTOP-{issue}/{index}-{slug}' },
};

const MAIN = 'packages/main/src/plugin/handler.ts';
const UI = 'packages/ui/src/lib/theme.svelte';

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-threads-'));

  await transition(ISSUE, 'triaged', { home });
  await setOwns(ISSUE, 'T1', [MAIN], { home });

  await slice.set({
    issue: ISSUE,
    home,
    config: CONFIG,
    facts: {
      issue: ISSUE,
      files: [
        { path: MAIN, package: null, layer: 'main', tasks: ['T1'], requirements: ['R1'] },
        { path: UI, package: null, layer: 'ui', tasks: [], requirements: [] },
      ],
      changed: [
        { status: 'M', path: MAIN },
        { status: 'M', path: UI },
      ],
      requirements: [],
      route: 'quickfix',
      base: 'main',
      ref: 'abc123',
      layerOrder: ['main', 'ui'],
    },
    proposal: {
      slices: [
        { index: 1, slug: 'main-part', title: 'main', files: [MAIN], baseSlice: null },
        { index: 2, slug: 'ui-part', title: 'ui', files: [UI], baseSlice: null },
      ],
    },
  });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('who is a bot', () => {
  test('the login suffix GitHub itself uses', () => {
    assert.equal(threads.isBot('dependabot[bot]', CONFIG), true);
    assert.equal(threads.isBot('renovate[bot]', {}), true, 'the suffix needs no configuration to be believed');
  });

  // coderabbitai posts under a plain login on some installations, so a filter
  // that only trusted the suffix would collapse nothing at all.
  test('and the names the config lists', () => {
    assert.equal(threads.isBot('coderabbitai', CONFIG), true);
    assert.equal(threads.isBot('CodeRabbitAI', CONFIG), true);
    assert.equal(threads.isBot('jiridostal', CONFIG), false);
    assert.equal(threads.isBot(null, CONFIG), false);
  });
});

describe('escalation', () => {
  test('a configured word is found however it is spelled in prose', () => {
    assert.deepEqual(threads.escalationsIn('This is a potential data loss.', CONFIG), ['data-loss']);
    assert.deepEqual(threads.escalationsIn('Security issue here', CONFIG), ['security']);
    assert.deepEqual(threads.escalationsIn('nit: rename this', CONFIG), []);
  });

  test('a config with no words escalates nothing rather than everything', () => {
    assert.deepEqual(threads.escalationsIn('security', {}), []);
  });
});

describe('collecting', () => {
  const thread = (extra) => ({
    id: 't1',
    author: 'coderabbitai',
    body: 'nit: prefer const',
    path: MAIN,
    line: 10,
    isResolved: false,
    createdAt: '2026-05-20T00:00:00Z',
    url: 'https://example/t1',
    ...extra,
  });

  const empty = { reviews: [], comments: [] };

  test('a bot thread collapses, a human thread never does', async () => {
    const facts = await threads.collect({
      issue: ISSUE,
      pr: 17577,
      config: CONFIG,
      home,
      threads: [thread(), thread({ id: 't2', author: 'jiridostal', body: 'x'.repeat(4000) })],
      discussion: empty,
    });

    assert.equal(facts.items[0].collapsed, true);
    assert.equal(facts.items[1].collapsed, false, 'length is not a reason to hide what a person wrote');
    assert.equal(facts.counts.collapsed, 1);
  });

  // The whole reason the matching is one-directional: dropping a security
  // finding because it lacked a word is the mistake the filter exists to
  // prevent, so the filter is not allowed to make it.
  test('an escalation word expands a bot back to full text', async () => {
    const facts = await threads.collect({
      issue: ISSUE,
      pr: 17577,
      config: CONFIG,
      home,
      threads: [thread({ body: 'This leaks a token — security problem.' })],
      discussion: empty,
    });

    assert.equal(facts.items[0].collapsed, false);
    assert.deepEqual(facts.items[0].escalated, ['security']);
    assert.equal(facts.counts.escalated, 1);
  });

  test('a thread is mapped to its slice, task and requirement', async () => {
    const facts = await threads.collect({
      issue: ISSUE,
      pr: 17577,
      config: CONFIG,
      home,
      satisfies: { T1: ['R1'] },
      threads: [thread({ author: 'jiridostal' })],
      discussion: empty,
    });

    assert.equal(facts.items[0].slice, 1);
    assert.deepEqual(facts.items[0].tasks, ['T1']);
    assert.deepEqual(facts.items[0].requirements, ['R1']);
    assert.equal(facts.items[0].mapped, true);
  });

  // Section 4: a thread that maps to nothing means either the reviewer found a
  // requirement the plan missed or the PR failed to explain itself, and both
  // are worth more than a quiet omission.
  test('a thread on a file in no slice is reported as unmapped', async () => {
    const facts = await threads.collect({
      issue: ISSUE,
      pr: 17577,
      config: CONFIG,
      home,
      threads: [thread({ author: 'jiridostal', path: 'packages/preload/src/index.ts' })],
      discussion: empty,
    });

    assert.equal(facts.unmapped.length, 1);
    assert.equal(facts.items[0].mapped, false);
  });

  test('a resolved thread is not counted as waiting, and not as unmapped', async () => {
    const facts = await threads.collect({
      issue: ISSUE,
      pr: 17577,
      config: CONFIG,
      home,
      threads: [thread({ author: 'jiridostal', isResolved: true, path: 'packages/preload/src/index.ts' })],
      discussion: empty,
    });

    assert.equal(facts.counts.unresolvedThreads, 0);
    assert.deepEqual(facts.unmapped, []);
  });

  // Straight from PR #17577: the two open threads are the bot's and the reason
  // the PR is blocked is a review body. Counting only threads would report that
  // no human is waiting.
  test('review submissions and comments are collected alongside threads', async () => {
    const facts = await threads.collect({
      issue: ISSUE,
      pr: 17577,
      config: CONFIG,
      home,
      threads: [thread(), thread({ id: 't2', path: UI })],
      discussion: {
        reviews: [{ author: 'benoitf', state: 'CHANGES_REQUESTED', body: 'please split this', at: '2026-06-05T00:00:00Z' }],
        comments: [{ author: 'jiridostal', body: 'any update?', at: '2026-06-02T00:00:00Z' }],
      },
    });

    assert.equal(facts.counts.humans, 2, 'the human feedback is not in a thread, and is still feedback');
    assert.deepEqual(
      facts.items.map((item) => item.kind),
      ['thread', 'thread', 'comment', 'review'],
      'everything is in the order it happened',
    );
    assert.equal(facts.items.at(-1).state, 'CHANGES_REQUESTED');
  });
});

describe('formatting', () => {
  test('a collapsed bot keeps its link', () => {
    const text = threads.format({
      items: [
        {
          kind: 'thread',
          author: 'coderabbitai',
          isBot: true,
          collapsed: true,
          escalated: [],
          path: MAIN,
          line: 10,
          isResolved: false,
          slice: 1,
          tasks: [],
          requirements: [],
          mapped: true,
          body: 'a'.repeat(4000),
          summary: 'nit: prefer const',
          url: 'https://example/t1',
        },
      ],
    });

    // Collapsing is about attention, not about hiding evidence: whoever has to
    // go and check still needs to get there.
    assert.match(text, /🤖 \*\*coderabbitai\*\*/);
    assert.match(text, /https:\/\/example\/t1/);
    assert.equal(text.includes('a'.repeat(200)), false);
  });

  test('an expanded item is quoted in full and says what it does not map to', () => {
    const text = threads.format({
      items: [
        {
          kind: 'thread',
          author: 'jiridostal',
          isBot: false,
          collapsed: false,
          escalated: [],
          path: 'packages/preload/src/index.ts',
          line: 4,
          isResolved: false,
          slice: null,
          tasks: [],
          requirements: [],
          mapped: false,
          body: 'this belongs in preload\nand nowhere else',
          summary: 'this belongs in preload',
          url: null,
        },
      ],
    });

    assert.match(text, /\*\*unmapped\*\*/);
    assert.match(text, /> this belongs in preload\n {2}> and nowhere else/);
  });

  test('nothing to show says so rather than rendering an empty list', () => {
    assert.equal(threads.format({ items: [] }), '_None._');
  });
});

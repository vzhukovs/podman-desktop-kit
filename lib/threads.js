/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// The facts /pd:pr-sync works from.
//
// The same division as lib/audit.js, applied to review feedback. Whether an
// author is a bot, which slice a thread's file belongs to, which task owns that
// file and which requirement that task satisfies — all set arithmetic, and
// therefore not something an Opus should be spending judgement on. What a
// reviewer meant, and whether to accept, discuss, defer or reject, is not
// arithmetic and is not decided here.
//
// Nothing in this module classifies. There is no accept/reject field and no
// verdict: a collector that graded the feedback would be answering the reviewer
// on its own.

import { get } from './config.js';
import { matchesAny } from './globs.js';
import { read as readGraph } from './slice.js';
import { read as readState } from './state.js';

/**
 * @typedef {object} Item
 * @property {'thread'|'review'|'comment'} kind
 * @property {string|null} id            thread id, for replying
 * @property {string|null} author
 * @property {boolean} isBot
 * @property {boolean} collapsed         shown as one line unless expanded
 * @property {string[]} escalated        escalation words found in the body
 * @property {string|null} path
 * @property {number|null} line
 * @property {boolean} isResolved
 * @property {string|null} at
 * @property {string|null} url
 * @property {string} body
 * @property {string} summary            first meaningful line, for the digest
 * @property {number|null} slice
 * @property {string[]} tasks
 * @property {string[]} requirements
 * @property {boolean} mapped            the path belongs to a slice we know
 */

/** GitHub marks app accounts this way, whatever they call themselves. */
const BOT_SUFFIX = /\[bot\]$/i;

/**
 * Whether an author is a bot, from the name alone.
 *
 * **The weaker of the two answers, and only for sources that do not report an
 * account type.** GitHub knows; ask it. `__typename === 'Bot'` on GraphQL and
 * `user.type === 'Bot'` on REST are the machine answer, and `botFrom` below
 * prefers them.
 *
 * What is left here is a name list and a suffix, and the suffix turned out to
 * match nothing on the paths this plugin uses: `gh pr view --json` strips
 * `[bot]`, and GraphQL never adds it. So until 0.20 bot detection was a list of
 * five names wearing a general rule — the same shape as the array check in 0.16
 * and the rtk check in 0.18, a sentence wider than its measurement. The list
 * stays because a source without a type still needs an answer, and because an
 * account that is a plain user posting automation is invisible to any type.
 *
 * @param {string|null} author
 * @param {object} config
 * @returns {boolean}
 */
export function isBot(author, config) {
  if (!author) return false;

  const listed = get(config, 'review.bots_collapsed');
  const names = (Array.isArray(listed) ? listed : []).map((name) => String(name).toLowerCase());

  const login = String(author).toLowerCase();
  return BOT_SUFFIX.test(login) || names.includes(login) || names.includes(login.replace(BOT_SUFFIX, ''));
}

/**
 * Whether one piece of feedback came from a bot, from both answers.
 *
 * The account type can only ADD — the same asymmetry escalation has below, and
 * for the same reason. `isBotAccount === false` means "GitHub calls this a
 * User", which is true of coderabbitai on the installations that made the name
 * list necessary in the first place; letting that outrank the list would
 * un-collapse exactly the accounts the list exists to catch. And a source that
 * never reported a type produces `false` here indistinguishably from one that
 * reported `User`, so treating `false` as an answer would make a dropped field
 * silently reclassify every bot as a person.
 *
 * Found by the tests: the first version of this preferred `isBotAccount` when
 * it was a boolean, and every fixture without a `__typename` turned its bot
 * into a human.
 *
 * @param {{author?: string|null, isBotAccount?: boolean}} source
 * @param {object} config
 * @returns {boolean}
 */
export function botFrom(source, config) {
  return source?.isBotAccount === true || isBot(source?.author ?? null, config);
}

/**
 * Escalation words found in a body.
 *
 * The asymmetry is the point, and it is worth being explicit about: a match
 * EXPANDS a collapsed bot thread back to full text. It never collapses
 * anything, and it is never consulted for a human. Dropping a security finding
 * because it failed to contain a configured word is precisely the mistake the
 * bot filter exists to prevent, so the filter is not allowed to make it.
 *
 * @param {string} body
 * @param {object} config
 * @returns {string[]}
 */
export function escalationsIn(body, config) {
  const listed = get(config, 'review.bot_escalate');
  const words = Array.isArray(listed) ? listed : [];

  const haystack = String(body ?? '').toLowerCase();

  return words
    .map((word) => String(word))
    // data-loss in the config is "data loss" in prose, and a reviewer writing
    // either means the same thing.
    .filter((word) => haystack.includes(word.toLowerCase().replace(/[-_]/g, ' ')) || haystack.includes(word.toLowerCase()));
}

/** Markdown decoration, quotes, and bot boilerplate headers. */
const NOISE = /^[>\s#*_`-]+|[*_`]+$/g;

/**
 * The first line worth showing in a one-line digest.
 *
 * @param {string} body
 * @returns {string}
 */
export function summarise(body) {
  const line = String(body ?? '')
    .split('\n')
    .map((text) => text.replace(NOISE, '').trim())
    .find((text) => text.length > 0);

  if (!line) return '(no text)';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * Which slice, task and requirement a path belongs to.
 *
 * @param {string|null} path
 * @param {{graph: object|null, owns: Record<string, string[]>, satisfies: Record<string, string[]>}} maps
 * @returns {{slice: number|null, tasks: string[], requirements: string[], mapped: boolean}}
 */
function locate(path, maps) {
  if (!path) return { slice: null, tasks: [], requirements: [], mapped: false };

  const slice = maps.graph?.slices.find((entry) => entry.files.includes(path)) ?? null;
  const tasks = Object.entries(maps.owns)
    .filter(([, files]) => matchesAny(path, files))
    .map(([id]) => id)
    .sort();

  const requirements = [...new Set(tasks.flatMap((id) => maps.satisfies[id] ?? []))].sort();

  // Mapped means "this file is part of work we know about". A thread on a file
  // in no slice and owned by no task is the signal section 4 asks for: either
  // the reviewer found a requirement the plan missed, or the PR failed to
  // explain itself.
  return { slice: slice?.index ?? null, tasks, requirements, mapped: slice !== null || tasks.length > 0 };
}

/**
 * Assemble everything a review sync reads, with nothing decided.
 *
 * @param {{issue: number, pr: number, threads: Array<object>, discussion: {reviews: Array<object>, comments: Array<object>}, config?: object, home?: string, satisfies?: Record<string, string[]>}} input
 * @returns {Promise<{issue: number, pr: number, items: Item[], unmapped: Item[], counts: object}>}
 */
export async function collect(input) {
  const config = input.config ?? {};
  const record = await readState(input.issue, input);
  const graph = await readGraph(input.issue, input);

  const maps = { graph, owns: record.owns ?? {}, satisfies: input.satisfies ?? {} };

  // Whether there is anything to map AGAINST. "This thread belongs to no slice"
  // is a finding only when slices exist; on an issue with no graph and no Owns
  // it is true of every thread, and reporting all of them as suspicious buries
  // the case the check was written for.
  const mappable = Boolean(graph) || Object.keys(maps.owns).length > 0;

  /** @param {object} source @param {Item['kind']} kind @returns {Item} */
  const asItem = (source, kind) => {
    const body = source.body ?? '';
    const bot = botFrom(source, config);
    const escalated = bot ? escalationsIn(body, config) : [];

    return {
      kind,
      id: source.id ?? null,
      author: source.author ?? null,
      isBot: bot,
      // A bot is collapsed unless it said one of the words. A human is never
      // collapsed, whatever they wrote and however long it was.
      collapsed: bot && escalated.length === 0,
      escalated,
      path: source.path ?? null,
      line: source.line ?? null,
      isResolved: Boolean(source.isResolved),
      at: source.at ?? source.createdAt ?? null,
      url: source.url ?? null,
      body,
      summary: summarise(body),
      ...locate(source.path ?? null, maps),
      // A review submission carries a state, and an APPROVED with no body says
      // something the body cannot.
      ...(source.state ? { state: source.state } : {}),
    };
  };

  const items = [
    ...input.threads.map((thread) => asItem(thread, 'thread')),
    ...(input.discussion?.reviews ?? []).map((review) => asItem(review, 'review')),
    ...(input.discussion?.comments ?? []).map((comment) => asItem(comment, 'comment')),
  ].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));

  const open = items.filter((item) => item.kind !== 'thread' || !item.isResolved);

  return {
    issue: input.issue,
    pr: input.pr,
    mappable,
    items,
    // Only threads can be unmapped in a useful sense: a top-level comment has
    // no file, and reporting every one of them as "maps to nothing" would bury
    // the threads that genuinely do not.
    unmapped: mappable ? items.filter((item) => item.kind === 'thread' && !item.mapped && !item.isResolved) : [],
    counts: {
      total: items.length,
      open: open.length,
      threads: items.filter((item) => item.kind === 'thread').length,
      unresolvedThreads: items.filter((item) => item.kind === 'thread' && !item.isResolved).length,
      bots: items.filter((item) => item.isBot).length,
      collapsed: items.filter((item) => item.collapsed).length,
      escalated: items.filter((item) => item.escalated.length > 0).length,
      humans: open.filter((item) => !item.isBot).length,
    },
  };
}

/**
 * The markdown block for prs/<k>.md and for reading in a terminal.
 *
 * A collapsed bot keeps its link. Collapsing is about attention, not about
 * hiding evidence: the reviewer who has to go and check will need to get there.
 *
 * @param {{items: Item[], mappable?: boolean}} facts
 * @param {{kinds?: Item['kind'][]}} [options]
 * @returns {string}
 */
export function format(facts, options = {}) {
  const kinds = options.kinds ?? ['thread', 'review', 'comment'];
  const items = facts.items.filter((item) => kinds.includes(item.kind));

  if (items.length === 0) return '_None._';

  const mappable = facts.mappable !== false;
  const lines = [];

  for (const item of items) {
    const where = item.path ? `\`${item.path}${item.line ? `:${item.line}` : ''}\`` : '—';
    // Only worth saying when there is a map to be outside of.
    const belongs = item.slice === null ? (item.mapped || !mappable || !item.path ? '' : ' **unmapped**') : ` slice #${item.slice}`;
    const trace = item.requirements.length ? ` (${item.requirements.join(', ')})` : '';
    const status = item.kind === 'thread' ? (item.isResolved ? 'resolved' : 'open') : (item.state ?? item.kind);

    if (item.collapsed) {
      lines.push(`- 🤖 **${item.author}** — ${status}, ${where}${belongs} — ${item.summary}${item.url ? ` ([thread](${item.url}))` : ''}`);
      continue;
    }

    lines.push(
      `- **${item.author}** — ${status}, ${where}${belongs}${trace}` +
        `${item.escalated.length ? ` — escalated: ${item.escalated.join(', ')}` : ''}`,
    );
    for (const line of item.body.split('\n')) lines.push(`  > ${line}`);
    if (item.url) lines.push(`  <${item.url}>`);
  }

  return lines.join('\n');
}

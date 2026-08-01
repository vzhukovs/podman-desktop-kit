// SPDX-License-Identifier: Apache-2.0

// Facts about a set of candidate issues (spec section 10, scenario 6).
//
// The question here is not "take this issue", it is "what is there to take".
// Same shape as lib/audit.js, lib/threads.js and lib/review.js: collect()
// gathers, format() prints, and nothing decides. There is no score field and
// no recommendation, because the thing that actually separates a good next
// issue from a bad one — whether the requirement is clear enough to plan — is
// not greppable, and a number here would look like it had been measured.
//
// What IS mechanical is narrow and worth doing exactly once, and section 10
// names it: is somebody already on it, did a maintainer answer, is there a
// reproduction. All three are facts about the issue as GitHub holds it.
//
// The order this module produces is an order over those facts and nothing
// more. It puts what cannot be started at the bottom and what carries the most
// signals at the top; it does not know which issue is worth doing.

import { get } from './config.js';
import * as gh from './gh.js';
import { isBot } from './threads.js';

/** Author associations that mean the commenter speaks for the project. */
const MAINTAINER = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);

/**
 * The required section of each upstream issue template, as the rendered body
 * spells it. Read from .github/ISSUE_TEMPLATE/*.yml on 2026-08-01.
 *
 * A body that matches none of them was written free-hand. That is not a
 * defect — plenty of good issues are — but it is the difference between a
 * reporter who answered the project's questions and one who did not, and it is
 * exactly what "clarity of requirements" starts from.
 */
const TEMPLATES = [
  { kind: 'bug', section: 'bug description' },
  { kind: 'feature', section: "describe the solution you'd like" },
  { kind: 'task', section: 'task content' },
  { kind: 'epic', section: 'epic domain' },
];

/** Where a bug report puts its reproduction, when it has one. */
const REPRODUCTION = 'steps to reproduce';

/**
 * What GitHub writes into a template section the reporter left empty.
 *
 * Without this the section heading alone would count as an answer, and every
 * bug filed through the template would report a reproduction — including the
 * ones whose reproduction field is literally blank.
 */
const EMPTY = /^_no response_$/i;

/** One day, in milliseconds. */
const DAY = 86_400_000;

/**
 * @typedef {object} Candidate
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string|null} author
 * @property {string[]} labels
 * @property {string[]} assignees
 * @property {string|null} template        which issue template the body follows
 * @property {'steps'|'missing'|'n/a'} reproduction
 * @property {{login: string, at: string|null}|null} maintainer  who answered, if anyone
 * @property {string|null} lastHumanActivity
 * @property {number|null} idleDays        since a human last touched it
 * @property {number} ageDays
 * @property {{total: number, recentHuman: number}} comments  recentHuman counts
 *   the last twenty only, which is what gh.openIssues asks for
 * @property {Array<object>} pulls         pull requests referencing it, this repository only
 * @property {Array<{kind: string, detail: string}>} blockers
 * @property {string[]} signals
 * @property {string[]} history            route-changing facts: reverted, closed-attempt
 */

/**
 * Split a rendered issue body into its template sections.
 *
 * @param {string} body
 * @returns {Map<string, string>} lower-cased heading -> content
 */
export function sections(body) {
  /** @type {Map<string, string>} */
  const found = new Map();
  let heading = null;
  let buffer = [];

  const flush = () => {
    if (heading !== null) found.set(heading, buffer.join('\n').trim());
  };

  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }

    flush();
    heading = match[1].toLowerCase();
    buffer = [];
  }
  flush();

  return found;
}

/**
 * Whether a section carries an answer rather than a heading.
 *
 * @param {Map<string, string>} parts
 * @param {string} name
 * @returns {boolean}
 */
function answered(parts, name) {
  const content = parts.get(name);
  return typeof content === 'string' && content !== '' && !EMPTY.test(content);
}

/**
 * Turn one raw issue into facts.
 *
 * @param {object} raw           as returned by gh.openIssues
 * @param {{config: object, now?: number}} context
 * @returns {Candidate}
 */
export function describe(raw, context) {
  const now = context.now ?? Date.now();
  const parts = sections(raw.body);

  const template = TEMPLATES.find((entry) => answered(parts, entry.section))?.kind ?? null;

  const reproduction = template !== 'bug' ? 'n/a' : answered(parts, REPRODUCTION) ? 'steps' : 'missing';

  // A bot is a bot by the account type GitHub reports, or by the configured
  // names. The type comes first because the stale bot arrives from GraphQL as
  // `github-actions`, with no suffix for isBot to recognise.
  const human = (raw.comments?.recent ?? []).filter(
    (comment) => !comment.isBotAccount && !isBot(comment.author, context.config),
  );

  // The issue author agreeing with themselves is not the project answering.
  // On #18381 the reporter is a MEMBER commenting on their own issue, which
  // would otherwise read as a maintainer having weighed in.
  const answer = human.filter(
    (comment) => MAINTAINER.has(String(comment.association)) && comment.author !== raw.author,
  );
  const maintainer = answer.length > 0 ? { login: answer[answer.length - 1].author, at: answer[answer.length - 1].at } : null;

  // `updatedAt` is not activity. A stale-bot notice moves it, a label moves it,
  // and sorting on it puts abandoned issues at the top of the list.
  const touched = [raw.createdAt, ...human.map((comment) => comment.at)]
    .filter(Boolean)
    .map((at) => Date.parse(at))
    .filter((at) => Number.isFinite(at));
  const lastHuman = touched.length > 0 ? Math.max(...touched) : null;

  const open = (raw.pulls ?? []).filter((pull) => pull.state === 'OPEN');
  const merged = (raw.pulls ?? []).filter((pull) => pull.mergedAt);
  const closed = (raw.pulls ?? []).filter((pull) => pull.state === 'CLOSED' && !pull.mergedAt);

  /** @type {Array<{kind: string, detail: string}>} */
  const blockers = [];
  if (open.length > 0) {
    blockers.push({ kind: 'open-pr', detail: open.map((pull) => `#${pull.number}`).join(', ') });
  }
  if ((raw.assignees ?? []).length > 0) {
    blockers.push({ kind: 'assigned', detail: raw.assignees.join(', ') });
  }

  /** @type {string[]} */
  const history = [];
  // A merged PR plus a revert is the `redo` route, and it is worth surfacing in
  // a listing: the archaeology is most of that job, and it changes the estimate.
  if (merged.length > 0 && (raw.pulls ?? []).some((pull) => pull.isRevert)) history.push('reverted');
  else if (merged.length > 0) history.push('merged-pr');
  if (closed.length > 0) history.push('closed-attempt');

  /** @type {string[]} */
  const signals = [];
  if (reproduction === 'steps') signals.push('reproduction');
  if (maintainer) signals.push('maintainer-replied');
  if (template) signals.push('template');

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author ?? null,
    labels: raw.labels ?? [],
    assignees: raw.assignees ?? [],
    template,
    reproduction,
    maintainer,
    lastHumanActivity: lastHuman ? new Date(lastHuman).toISOString() : null,
    idleDays: lastHuman ? Math.floor((now - lastHuman) / DAY) : null,
    ageDays: raw.createdAt ? Math.floor((now - Date.parse(raw.createdAt)) / DAY) : 0,
    // Not "how many humans commented": the query asks for the last twenty, so
    // this counts humans among those. The total is the total.
    comments: { total: raw.comments?.total ?? 0, recentHuman: human.length },
    pulls: raw.pulls ?? [],
    blockers,
    signals,
    history,
  };
}

/**
 * Order the candidates.
 *
 * Blocked last, then more signals first, then least idle, then newest. Every
 * tier is a fact from section 10, and the last one is there only so that two
 * runs over the same backlog print the same list — an order that shuffles is
 * an order nobody can talk about.
 *
 * @param {Candidate[]} candidates
 * @returns {Candidate[]}
 */
export function order(candidates) {
  return [...candidates].sort((left, right) => {
    if ((left.blockers.length > 0) !== (right.blockers.length > 0)) return left.blockers.length > 0 ? 1 : -1;
    if (left.signals.length !== right.signals.length) return right.signals.length - left.signals.length;

    const idle = (candidate) => (candidate.idleDays === null ? Number.MAX_SAFE_INTEGER : candidate.idleDays);
    if (idle(left) !== idle(right)) return idle(left) - idle(right);

    return right.number - left.number;
  });
}

/**
 * @typedef {object} Report
 * @property {string} repository
 * @property {string[]} labels           the filter that was applied
 * @property {number} scanned
 * @property {Candidate[]} candidates    ordered
 * @property {number} available          how many nothing blocks
 */

/**
 * Gather the facts behind "what is there to take".
 *
 * Read-only, and deliberately so: nothing here moves an issue into `triaged`.
 * A listing that triaged what it listed would be a listing that picked, and
 * picking is the one part of scenario 6 that is not mechanical.
 *
 * @param {{labels?: string[], limit?: number, config: object, now?: number, exec?: Function}} input
 * @returns {Promise<Report>}
 */
export async function collect(input) {
  const raw = await gh.openIssues({
    labels: input.labels ?? [],
    limit: input.limit,
    config: input.config,
    exec: input.exec,
  });

  const candidates = order(raw.map((issue) => describe(issue, { config: input.config, now: input.now })));

  return {
    repository: String(get(input.config, 'repo.upstream') ?? ''),
    labels: input.labels ?? [],
    scanned: raw.length,
    candidates,
    available: candidates.filter((candidate) => candidate.blockers.length === 0).length,
  };
}

/**
 * One line of the listing.
 *
 * @param {Candidate} candidate
 * @returns {string}
 */
function line(candidate) {
  const mark = candidate.blockers.length > 0 ? '·' : '○';
  const title = candidate.title.length > 58 ? `${candidate.title.slice(0, 57)}…` : candidate.title;

  const notes = [
    ...candidate.blockers.map((blocker) => `${blocker.kind} (${blocker.detail})`),
    ...candidate.history,
    ...candidate.signals,
    candidate.reproduction === 'missing' ? 'no-reproduction' : null,
    candidate.idleDays === null ? null : `idle ${candidate.idleDays}d`,
  ].filter(Boolean);

  return `  ${mark} #${String(candidate.number).padEnd(6)} ${title.padEnd(58)} ${notes.join(', ')}`;
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const filter = report.labels.length > 0 ? ` matching ${report.labels.join(' + ')}` : '';
  const lines = [`backlog: ${report.scanned} open issue(s)${filter} in ${report.repository}`, ''];

  if (report.candidates.length === 0) {
    lines.push('  Nothing came back. Widen the filter, or raise --limit.', '');
    return lines.join('\n');
  }

  for (const candidate of report.candidates) lines.push(line(candidate));

  lines.push(
    '',
    `  ${report.available} of ${report.scanned} have nothing blocking a start; · marks the rest.`,
    '',
    '  This is an order over facts, not a recommendation. Whether a requirement',
    '  is clear enough to plan is not in this table, and it is the thing that',
    '  decides. Read the top few, then triage one: pdkit issue fetch <n>.',
    '',
  );

  return lines.join('\n');
}

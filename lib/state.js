// SPDX-License-Identifier: Apache-2.0

// The issue state machine (spec section 1).
//
// INVARIANT: this module is the only writer of $PDKIT_HOME/issues/<n>/state.json.
// Skills and agents ask for a transition; they never edit the file. That is what
// makes "the gate only opens from preflight-green" a fact rather than a request.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import { append as appendJournal } from './journal.js';

/** @typedef {'new'|'triaged'|'quickfix'|'planned'|'plan-approved'|'implemented'|'validated'|'audited'|'sliced'|'slices-approved'|'preflight-green'|'pr-open'|'review-in-progress'|'merged'|'abandoned'} State */

/**
 * Allowed transitions. A transition absent from this table is not "unusual",
 * it is rejected — including transitions an agent is convinced are correct.
 *
 * @type {Record<State, State[]>}
 */
export const TRANSITIONS = {
  'new': ['triaged'],
  'triaged': ['quickfix', 'planned', 'abandoned'],
  'quickfix': ['preflight-green', 'triaged'],
  'planned': ['plan-approved', 'triaged'],
  'plan-approved': ['implemented'],
  'implemented': ['validated'],
  'validated': ['audited'],
  'audited': ['sliced'],
  'sliced': ['slices-approved'],
  'slices-approved': ['preflight-green'],
  'preflight-green': ['pr-open'],
  // Back to preflight-green from pr-open, because an issue with three slices
  // passes through it three times. The gate is issued per branch and only from
  // preflight-green (section 1), so without this edge the second slice of a
  // sliced issue could never be pushed — and widening GATE_ELIGIBLE instead
  // would open a way around preflight itself, which is the one thing that set
  // is narrow to prevent.
  'pr-open': ['preflight-green', 'review-in-progress', 'merged', 'abandoned'],
  'review-in-progress': ['preflight-green', 'merged', 'abandoned'],
  'merged': [],
  'abandoned': [],
};

/** States from which a push gate may be issued at all. */
export const GATE_ELIGIBLE = ['preflight-green'];

/**
 * @typedef {object} Record_
 * @property {number} issue
 * @property {State} state
 * @property {'standard'|'quickfix'|null} route
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 * @property {Record<string, {at: string, by: string}>} approvals
 * @property {{ids: string[], next: number, frozen: boolean}} requirements
 * @property {{task: number, slice: number}} counters
 * @property {Record<string, string[]>} owns  task ID -> files it may write
 * @property {Array<{at: string, from: State, to: State, reason: string|null}>} history
 */

/**
 * The record an issue has before anything has happened to it. Returned rather
 * than written: reading the state of an untouched issue must not create files.
 *
 * @param {number} issue
 * @returns {Record_}
 */
function blank(issue) {
  return {
    issue,
    state: 'new',
    route: null,
    createdAt: null,
    updatedAt: null,
    approvals: {},
    requirements: { ids: [], next: 1, frozen: false },
    counters: { task: 1, slice: 1 },
    owns: {},
    history: [],
  };
}

/**
 * @param {number} issue
 * @param {{home?: string}} options
 * @returns {string}
 */
function recordPath(issue, options) {
  return join(issueDir(options.home ?? resolveHome(), issue), 'state.json');
}

/**
 * Read the state record for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Record_>}
 */
export async function read(issue, options = {}) {
  const file = recordPath(issue, options);

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return blank(issue);
    throw error;
  }

  try {
    return { ...blank(issue), ...JSON.parse(raw) };
  } catch (error) {
    throw new Error(`${file}: state record is not readable JSON`, { cause: error });
  }
}

/**
 * Whether an issue has a record on disk yet.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<boolean>}
 */
export async function exists(issue, options = {}) {
  const record = await read(issue, options);
  return record.createdAt !== null;
}

/**
 * Persist a record. Private on purpose: every caller goes through one of the
 * named operations below, so the set of things that can happen to a record is
 * the set of functions in this file.
 *
 * @param {Record_} record
 * @param {{home?: string}} options
 * @returns {Promise<Record_>}
 */
async function save(record, options) {
  const file = recordPath(record.issue, options);
  const now = new Date().toISOString();

  const next = { ...record, createdAt: record.createdAt ?? now, updatedAt: now };

  await mkdir(dirname(file), { recursive: true });
  // Write beside the target and rename: a crash mid-write leaves the previous
  // record intact rather than a truncated one, and a truncated state record is
  // indistinguishable from an issue nobody has touched.
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file);

  return next;
}

/**
 * Attempt a transition. Rejects when the target is not reachable from the
 * current state, and appends the accepted move to the journal.
 *
 * A refused transition returns rather than throws: "you cannot open a PR from
 * triaged" is an answer the caller has to show the user, not a failure of the
 * program.
 *
 * @param {number} issue
 * @param {State} to
 * @param {{reason?: string, approvedBy?: string, home?: string}} [meta]
 * @returns {Promise<{ok: boolean, from: State, to: State, error?: string, record?: Record_}>}
 */
export async function transition(issue, to, meta = {}) {
  const record = await read(issue, meta);
  const from = record.state;

  if (!(to in TRANSITIONS)) {
    return { ok: false, from, to, error: `"${to}" is not a state` };
  }
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from] ?? [];
    return {
      ok: false,
      from,
      to,
      error: allowed.length
        ? `${from} -> ${to} is not an allowed transition (from ${from}: ${allowed.join(', ')})`
        : `${from} is terminal; no transition is allowed`,
    };
  }

  const next = {
    ...record,
    state: to,
    // Going back to triaged clears the route. An escalated quickfix has to be
    // able to allocate R-IDs, and it allocates them from the issue's
    // requirements — which is why it returns to triage rather than moving
    // sideways into planning with a diff already in hand.
    route: to === 'quickfix' ? 'quickfix' : to === 'planned' ? 'standard' : to === 'triaged' ? null : record.route,
    history: [...record.history, { at: new Date().toISOString(), from, to, reason: meta.reason ?? null }],
  };

  if (meta.approvedBy) {
    next.approvals = { ...record.approvals, [to]: { at: new Date().toISOString(), by: meta.approvedBy } };
  }

  const saved = await save(next, meta);
  await appendJournal(
    { issue, event: to, detail: [meta.reason, meta.approvedBy && `approved by ${meta.approvedBy}`].filter(Boolean).join('; ') },
    meta,
  );

  return { ok: true, from, to, record: saved };
}

/**
 * Allocate the next requirement number.
 *
 * The freeze and the quickfix rule live here rather than in lib/ids.js because
 * they are properties of the record: checking them in the caller would leave a
 * window between the check and the write in which either could change.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: boolean, value?: number, error?: string}>}
 */
export async function allocateRequirement(issue, options = {}) {
  const record = await read(issue, options);

  if (record.route === 'quickfix') {
    return { ok: false, error: `issue ${issue} is on the quickfix route: no R-IDs are allocated, tracing goes by issue number` };
  }
  if (record.requirements.frozen) {
    return { ok: false, error: `requirements for issue ${issue} were frozen on plan approval` };
  }

  const value = record.requirements.next;
  await save(
    { ...record, requirements: { ids: [...record.requirements.ids, `R${value}`], next: value + 1, frozen: false } },
    options,
  );

  return { ok: true, value };
}

/**
 * Freeze the requirement set. Called on plan approval.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: boolean, ids?: string[], error?: string}>}
 */
export async function freezeRequirements(issue, options = {}) {
  const record = await read(issue, options);

  if (record.route === 'quickfix') {
    return { ok: false, error: `issue ${issue} is on the quickfix route: there are no requirements to freeze` };
  }

  const ids = record.requirements.ids;
  if (!record.requirements.frozen) {
    await save({ ...record, requirements: { ...record.requirements, frozen: true } }, options);
    await appendJournal({ issue, event: 'requirements-frozen', detail: `${ids.join(',') || 'none'} frozen` }, options);
  }

  return { ok: true, ids };
}

/**
 * Allocate the next task or slice number.
 *
 * @param {number} issue
 * @param {'task'|'slice'} kind
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: boolean, value?: number, error?: string}>}
 */
export async function allocateCounter(issue, kind, options = {}) {
  if (kind !== 'task' && kind !== 'slice') return { ok: false, error: `unknown counter "${kind}"` };

  const record = await read(issue, options);
  const value = record.counters[kind];
  await save({ ...record, counters: { ...record.counters, [kind]: value + 1 } }, options);

  return { ok: true, value };
}

/**
 * Record the files a task owns. The pre-write hook reads this on stage 2;
 * planning writes it.
 *
 * @param {number} issue
 * @param {string} taskId
 * @param {string[]} files
 * @param {{home?: string}} [options]
 * @returns {Promise<Record_>}
 */
export async function setOwns(issue, taskId, files, options = {}) {
  const record = await read(issue, options);
  return save({ ...record, owns: { ...record.owns, [taskId]: files } }, options);
}

/**
 * Whether a transition is allowed, without performing it.
 *
 * @param {State} from
 * @param {State} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

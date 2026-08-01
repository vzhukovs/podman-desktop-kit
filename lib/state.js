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

/**
 * States a consent token may be issued from, by what is being written.
 *
 * Two kinds, because stage 4 introduced a write that has no branch. Pushing
 * publishes code and is allowed from exactly one state; replying to a review
 * thread publishes a sentence, belongs to no branch, and happens when the issue
 * is in review — where preflight has nothing to say about it.
 *
 * Here rather than in the config, and `gates.require_states` was deleted for
 * this reason: the only thing such a key can really do is WIDEN the list, and a
 * widened push list is a token issued before preflight. The whole plugin rests
 * on the unwanted input not existing (receipts, the verify verdict), and a knob
 * that opens the gate wider contradicts exactly that.
 */
export const GATE_ELIGIBLE = {
  push: ['preflight-green'],
  reply: ['pr-open', 'review-in-progress'],
};

/** The kinds of write a token can be issued for. */
export const GATE_KINDS = Object.keys(GATE_ELIGIBLE);

/**
 * The routes triage can choose (section 4).
 *
 * `invalid` is deliberately not here: it is not a way of doing the work, it is
 * the finding that there is none, and the machine already expresses it as the
 * `abandoned` state. A route nothing can ever leave would be a second spelling
 * of a state that exists.
 *
 * Until 0.10 this vocabulary lived in three places and disagreed in all of
 * them: state.js knew two values, lib/preflight/index.js declared four, and
 * section 4 asked for five. Nothing broke, because the only consumer asks about
 * `quickfix` — but `multi-slice` and `redo` could not be recorded at all, which
 * is why the redo route had no way to exist beyond a sentence in a skill.
 */
export const ROUTES = ['standard', 'quickfix', 'multi-slice', 'redo'];

/**
 * @typedef {object} Record_
 * @property {number} issue
 * @property {State} state
 * @property {'standard'|'quickfix'|'multi-slice'|'redo'|null} route
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 * @property {{at: string, reason: string, pr: number|null, branch: string|null}|null} adopted
 *   set when the work predates the plugin: the artefacts of the states before
 *   this one were never produced, rather than lost
 * @property {Record<string, {at: string, by: string}>} approvals
 * @property {{ids: string[], next: number, frozen: boolean}} requirements
 * @property {{task: number, slice: number, amendment: number, validation: number}} counters
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
    adopted: null,
    approvals: {},
    requirements: { ids: [], next: 1, frozen: false },
    counters: { task: 1, slice: 1, amendment: 1, validation: 1 },
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
 * Whether a file is there. Private, and used for one question only: has the
 * previous attempt been looked up.
 *
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function hasFile(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
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
 * @param {{reason?: string, approvedBy?: string, route?: string, home?: string}} [meta]
 * @returns {Promise<{ok: boolean, from: State, to: State, error?: string, record?: Record_}>}
 */
export async function transition(issue, to, meta = {}) {
  const record = await read(issue, meta);
  const from = record.state;

  if (!(to in TRANSITIONS)) {
    return { ok: false, from, to, error: `"${to}" is not a state` };
  }
  if (meta.route !== undefined && meta.route !== null && !ROUTES.includes(meta.route)) {
    return { ok: false, from, to, error: `"${meta.route}" is not a route (${ROUTES.join(', ')})` };
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

  // The redo route names an ordering, and section 10 puts it in bold: the
  // archaeology comes BEFORE any implementation. Held here rather than asked
  // for in the skill, because a sentence in a prompt is what it was until now.
  //
  // What the check can honestly demand is that the previous attempt was looked
  // up — the facts file is written only from a real lookup, so prose cannot
  // produce it. Whether its lesson was learned is not checkable, and pretending
  // otherwise would be a gate reporting on what it did not do.
  if (record.route === 'redo' && (to === 'planned' || to === 'quickfix')) {
    const facts = join(issueDir(meta.home ?? resolveHome(), issue), 'archaeology.json');
    if (!(await hasFile(facts))) {
      return {
        ok: false,
        from,
        to,
        error:
          `issue ${issue} is on the redo route: the previous attempt has not been looked up.\n` +
          `  Run: pdkit issue history ${issue}\n` +
          `  What was tried, what broke it and what the reviewers objected to comes first — re-implementing ` +
          `to rediscover it is the expensive path, and it is the one this route exists to close.`,
      };
    }
  }

  const next = {
    ...record,
    state: to,
    // Going back to triaged clears the route unless triage names a new one. An
    // escalated quickfix has to be able to allocate R-IDs, and it allocates them
    // from the issue's requirements — which is why it returns to triage rather
    // than moving sideways into planning with a diff already in hand.
    //
    // Planning keeps a route triage chose. Overwriting `redo` with `standard`
    // here would erase the one thing that makes the next issue's history
    // legible: that this work has been tried before.
    // Routes stay exclusive: a redo small enough for the quickfix route becomes
    // a quickfix, and what records that it had been tried before is
    // archaeology.json on disk, plus the journal. Carrying both would mean
    // every consumer of `route` had to ask about two things.
    route:
      to === 'triaged'
        ? (meta.route ?? null)
        : to === 'quickfix'
          ? 'quickfix'
          : to === 'planned'
            ? (record.route ?? 'standard')
            : record.route,
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
 * Take work that already exists in the world into the machine.
 *
 * Scenario 5 assumes an issue this plugin has been carrying. The common case is
 * the opposite one: a branch pushed and a pull request opened before the plugin
 * existed, whose issue reads `new` while GitHub shows it open. Walking it
 * through the whole chain to make the record agree would mean writing a plan
 * nobody planned and freezing requirements nobody drafted — inventing the
 * artefacts the machine exists to demand.
 *
 * So adoption records what is true and marks the record as adopted. The
 * missing artefacts stay missing, and `adopted` is why: an issue with no plan
 * because nobody wrote one is a different thing from an issue whose plan was
 * lost, and later readers — audit, r-coverage, a person six weeks on — need to
 * tell them apart.
 *
 * Only from `new`, and deliberately. Adopting over a live record would
 * overwrite the history the machine kept, which is the one thing here that
 * cannot be reconstructed.
 *
 * @param {number} issue
 * @param {{state: State, reason: string, pr?: number|null, branch?: string|null, route?: string, home?: string}} input
 * @returns {Promise<{ok: boolean, error?: string, record?: Record_}>}
 */
export async function adopt(issue, input) {
  const record = await read(issue, input);

  if (record.state !== 'new') {
    return {
      ok: false,
      error:
        `issue ${issue} is already at ${record.state}: adoption is for work the plugin has never seen.\n` +
        `  Moving a live record would overwrite the history it kept, which is the part that cannot be reconstructed.`,
    };
  }
  if (!(input.state in TRANSITIONS)) return { ok: false, error: `"${input.state}" is not a state` };
  if (input.route !== undefined && input.route !== null && !ROUTES.includes(input.route)) {
    return { ok: false, error: `"${input.route}" is not a route (${ROUTES.join(', ')})` };
  }
  if (!input.reason?.trim()) {
    return { ok: false, error: 'adoption needs a reason: it is the only account of where this work came from' };
  }

  const at = new Date().toISOString();
  const saved = await save(
    {
      ...record,
      state: input.state,
      route: input.route ?? 'standard',
      adopted: { at, reason: input.reason.trim(), pr: input.pr ?? null, branch: input.branch ?? null },
      // The history says what happened, and what happened is that the machine
      // met this work already in progress. It does not claim the states in
      // between were passed.
      history: [...record.history, { at, from: 'new', to: input.state, reason: `adopted: ${input.reason.trim()}` }],
    },
    input,
  );

  await appendJournal(
    {
      issue,
      event: 'adopted',
      detail: [`at ${input.state}`, input.pr ? `#${input.pr}` : null, input.branch, input.reason.trim()].filter(Boolean).join('; '),
    },
    input,
  );

  return { ok: true, record: saved };
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

/** Counters an issue hands out numbers from. */
const COUNTERS = ['task', 'slice', 'amendment', 'validation'];

/**
 * Allocate the next task, slice or amendment number.
 *
 * @param {number} issue
 * @param {'task'|'slice'|'amendment'} kind
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: boolean, value?: number, error?: string}>}
 */
export async function allocateCounter(issue, kind, options = {}) {
  if (!COUNTERS.includes(kind)) return { ok: false, error: `unknown counter "${kind}"` };

  const record = await read(issue, options);
  // A record written before a counter existed has no field for it, and falling
  // through to undefined would produce `A undefined`. Starting at 1 is right
  // here and only here: an issue predating the counter has no amendments.
  const value = record.counters[kind] ?? 1;
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

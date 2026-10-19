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

// The issue state machine (spec section 1).
//
// INVARIANT: this module is the only writer of $PDKIT_HOME/issues/<n>/state.json.
// Skills and agents ask for a transition; they never edit the file. That is what
// makes "the gate only opens from preflight-green" a fact rather than a request.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { issueDir, paths, resolveHome } from './config.js';
import { append as appendJournal } from './journal.js';

/** @typedef {'new'|'triaged'|'quickfix'|'planned'|'plan-approved'|'implemented'|'validated'|'audited'|'sliced'|'slices-approved'|'preflight-green'|'pr-open'|'review-in-progress'|'answered'|'merged'|'resolved'|'abandoned'} State */

/**
 * Allowed transitions. A transition absent from this table is not "unusual",
 * it is rejected — including transitions an agent is convinced are correct.
 *
 * @type {Record<State, State[]>}
 */
export const TRANSITIONS = {
  'new': ['triaged'],
  // `answered` from both of the states where the finding actually arrives.
  // Sometimes the cause is outside our tree and the triage sees it; more often
  // the investigation is the work, and by then the issue is `planned`. Measured
  // on #18284, where the report is a real, reproducible bug in podman-desktop
  // and the cause is a version skew between the podman client and the machine
  // it drives — nothing in this repository to change, and a reproduction, a
  // detector command and a workaround to publish.
  'triaged': ['quickfix', 'planned', 'answered', 'abandoned'],
  'quickfix': ['preflight-green', 'triaged'],
  'planned': ['plan-approved', 'triaged', 'answered'],
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
  // Back to triage from an open pull request, because "the reviewer rejected
  // the approach" is a normal outcome of review in someone else's repository
  // and the machine had no way to say it. Without this edge the only moves from
  // here are to push again — which assumes the design survived — or to abandon,
  // which throws away an issue that is still worth doing. Found on #17577,
  // where a maintainer named the alternative design in the review body.
  //
  // Not a shortcut back into planning: it lands on `triaged`, so the route is
  // chosen again and planning runs from the issue rather than from the diff
  // that was refused. The same ordering escalate enforces, for the same reason.
  'pr-open': ['preflight-green', 'review-in-progress', 'triaged', 'merged', 'abandoned'],
  'review-in-progress': ['preflight-green', 'triaged', 'merged', 'abandoned'],
  // Answered is deliberately NOT terminal, and that is the correction the run
  // on #18284 made to its own design. The obvious move was a terminal state
  // meaning "settled without a diff" — but the moment the findings are posted,
  // the issue is not settled: it is waiting on the reporter to confirm, which
  // is exactly where #18284 sits, with one reporter asked to check and another
  // saying they cannot. The machine could already wait on a reviewer
  // (`review-in-progress`, `awaiting-review`) and could not wait on a reporter.
  //
  // Three exits, because all three happen. They confirm and it closes; the
  // answer turns out to imply product work — on #18284 the obvious candidate is
  // that Podman Desktop shows a 6.0.1 client driving a 5.8.2 machine and says
  // nothing — and planning starts from the issue again; or nobody ever answers.
  'answered': ['resolved', 'planned', 'abandoned'],
  'merged': [],
  // Settled, and not by a diff of ours. Distinct from `merged`, which claims a
  // change landed, and from `abandoned`, which says the work was dropped —
  // here the work is the entire deliverable and it was published. Reading one
  // of the other two would be false in a way nothing else on disk corrects.
  'resolved': [],
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
 *
 * `merged` is on the reply list, and it was added by walking into the refusal it
 * fixes. A reviewer asked a question on #18561 a week after it merged; answering
 * is an ordinary continuation of the same review conversation, and the gate said
 * the issue was merged and refused. That is the failure section 6 names for the
 * tracker rules — a gate that cannot open is worse than a refusal that says what
 * to do — except here there is no route saying a human posts it instead, because
 * replying on your own pull request is exactly what `pr reply` is for.
 *
 * It widens nothing about publishing code. `push` is still one state, and a
 * reply token cannot be found for a push: the keys are of different kinds, which
 * is the hole stage 4 closed. What it authorises is a sentence on a pull request
 * that already exists.
 */
export const GATE_ELIGIBLE = {
  push: ['preflight-green'],
  reply: ['pr-open', 'review-in-progress', 'merged'],
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
 * The skill that advances an issue out of each state.
 *
 * Written because its absence produced a real failure. Nothing in the plugin
 * ever named the next command: every skill ends on a `pdkit state --to` call and
 * stops, and what the machine prints is `next: implemented` — a STATE. Seven of
 * the eight states in the chain are spelled like the command that reaches them
 * (`triaged`/triage, `planned`/plan, `validated`/validate …), so a model handed
 * "next: implemented" applies the pattern and types `/pd:implement`, which does
 * not exist. Observed on DESKTOP-18832, at exactly the one state whose name and
 * command diverge.
 *
 * The table is here rather than in the skills for the reason the architecture
 * gives for hooks: a handoff that lives only in prose is a handoff that holds
 * most of the time. The skills say it too — but this is what is printed by the
 * command the model has just run, whether or not it read anything.
 *
 * `null` is not a gap. It means the next move is not a skill: a terminal state,
 * or an approval that is a person's to give.
 *
 * @type {Record<State, string|null>}
 */
export const ADVANCES = {
  'new': 'triage',
  // The quickfix route overrides this; see nextStep.
  'triaged': 'plan',
  'quickfix': 'preflight',
  'planned': 'plan-review',
  'plan-approved': 'exec',
  'implemented': 'validate',
  'validated': 'audit',
  'audited': 'slice',
  // Approval is a human action, and branches are cut from it.
  'sliced': null,
  'slices-approved': 'preflight',
  'preflight-green': 'pr',
  'pr-open': 'pr-status',
  'review-in-progress': 'pr-sync',
  'answered': 'close',
  'merged': null,
  'resolved': null,
  'abandoned': null,
};

/**
 * Arguments each skill takes, where they are not the issue number.
 *
 * `<pr>` stays a placeholder on purpose: the number lives in `prs.json`, and
 * this module is not its reader. A placeholder the caller has to fill is honest;
 * a number guessed here would be wrong on any issue with more than one.
 */
const ARGUMENTS = {
  'pr-status': '',
  'pr-sync': ' <pr>',
};

/**
 * What to run next, as one line, or null where nothing follows.
 *
 * Takes the whole record rather than the state, because one answer depends on
 * the route: an issue triaged onto the quickfix route does not go to `/pd:plan`,
 * and sending it there is the mistake `escalate` exists to undo.
 *
 * @param {Record_} record
 * @returns {string|null}
 */
export function nextStep(record) {
  const issue = record.issue;

  // Two states whose next move is a decision rather than a command. Saying so
  // beats naming a skill that would run before the decision was taken.
  if (record.state === 'sliced') {
    return `pdkit state ${issue} --to slices-approved — approval is yours; branches are cut from it`;
  }
  if (record.state === 'answered') {
    return `/pd:close ${issue} — once the reporter confirms; back to /pd:plan ${issue} if the answer implied product work`;
  }

  const skill = nextSkill(record);
  if (!skill) return null;

  return `/pd:${skill}${ARGUMENTS[skill] ?? ` ${issue}`}`;
}

/**
 * The skill the next step runs, by name, or null where the next step is not one.
 *
 * `sliced` and `answered` are null although nextStep has a line for them: what
 * follows there is a human decision, not a phase, and a phase is what this
 * answer is used to prepare for. A separate function rather than a second shape
 * of nextStep's return, because that line is read as a string by more than one
 * caller.
 *
 * @param {Record_} record
 * @returns {string|null}
 */
export function nextSkill(record) {
  if (record.state === 'sliced' || record.state === 'answered') return null;
  return (record.state === 'triaged' && record.route === 'quickfix' ? 'quickfix' : ADVANCES[record.state]) ?? null;
}

/**
 * Everything the machine knows about one issue, as stored in state.json.
 *
 * The whole record, not a summary of it: `counters` is why an R-ID is never
 * reissued, `approvals` is where the two human decisions are kept, `owns` is
 * what the pre-write hook reads, and `history` is why a state can be explained
 * afterwards rather than merely observed. Nothing else may write this file
 * (invariant 1), which is what makes "the gate only opens from preflight-green"
 * a property rather than a promise.
 *
 * @typedef {object} Record_
 * @property {number} issue
 * @property {State} state
 * @property {'standard'|'quickfix'|'multi-slice'|'redo'|null} route
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 * @property {{at: string, state: State, reason: string, pr: number|null, branch: string|null}|null} adopted
 *   set when the work predates the plugin: the artefacts of the states before
 *   this one were never produced, rather than lost
 * @property {Record<string, {at: string, by: string}>} approvals
 * @property {{ids: string[], next: number, frozen: boolean, amendments?: string[]}} requirements
 *   `amendments` names the approved amendments whose table has been applied to
 *   `ids`, so that applying one is something that happens once
 * @property {{task: number, slice: number, amendment: number, validation: number, deferral: number}} counters
 * @property {Record<string, string[]>} owns  task ID -> files it may write
 * @property {Record<string, {amendment: string|null, replacedBy: string[], at: string}>} withdrawn
 *   tasks an amendment took out of the plan; they keep their IDs and lose their `owns`
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
    counters: { task: 1, slice: 1, amendment: 1, validation: 1, deferral: 1 },
    owns: {},
    withdrawn: {},
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
 * Whether anything was actually captured for this issue.
 *
 * Counted as files rather than by reading validation.json, and not out of
 * laziness: lib/validation.js imports this module, so importing it back would
 * be a cycle, and re-deriving the record's shape here would give that file a
 * second reader who could disagree with its owner. What is asked instead is the
 * same question archaeology.json answers for the redo route — is there
 * something on disk that only a real run could have put there. `validation/*`
 * holds receipts written by `pdkit validate attach --run`, and evidence.js has
 * no parameter through which output could be handed in, so the file cannot be
 * talked into existing.
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasCapture(dir) {
  try {
    return (await readdir(dir)).some((name) => name.endsWith('.md'));
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
 * `head` and `branch` are what the caller is standing on, and only the move to
 * `preflight-green` reads them: evidence for a commit that is no longer checked
 * out is evidence about a diff that no longer exists. They are resolved by the
 * command rather than typed, which is the whole point — a caller cannot assert
 * readiness by naming a commit, only by having run the checks on one.
 *
 * @param {{reason?: string, approvedBy?: string, route?: string, home?: string, head?: string|null, branch?: string|null, slice?: number|null}} [meta]
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

  // The state the whole design rests on, and until now the only one that could
  // simply be asserted. Section 1 states it as the hard rule — a push token is
  // issued from `preflight-green` and nowhere else — and the gate does check it.
  // Nothing checked that it was true. `slices-approved -> preflight-green` is a
  // legal move, so the entire chain of gates could be replaced by typing the
  // name of its outcome. Walked into on DESKTOP-18832: a session set it by hand
  // after a slice graph landed, opened a token, and pushed.
  //
  // Now it is earned from the file preflight writes. Same device as `answered`
  // above and the redo route below: a state is reachable when something on disk
  // exists that only a real run could have put there. The difference is that
  // preflight used to write nothing at all — it printed a report and forgot it —
  // which is why this was the one rule with no evidence behind it.
  if (to === 'preflight-green') {
    const { evidence } = await import('./preflight/record.js');
    const found = await evidence(issue, { home: meta.home ?? resolveHome(), head: meta.head ?? null, branch: meta.branch ?? null });

    if (!found.ok) {
      return {
        ok: false,
        from,
        to,
        error:
          `issue ${issue} has not been shown to be ready to publish:\n` +
          found.problems.map((problem) => `    ${problem}\n`).join('') +
          `  Run: pdkit preflight ${issue}${meta.slice ? ` --slice ${meta.slice}` : ''}, then again with --body-only --body <file>\n` +
          `  This state is what the push gate opens from, so asserting it is asserting every check under it.`,
      };
    }
  }

  // An answer published instead of a diff is still subject to the rule that
  // decides everything else here: the outcome follows what is attached. A
  // workaround nobody ran is a suggestion, and a suggestion posted on someone
  // else's tracker in the voice of a finding is worse than silence — the
  // reporter spends their evening on it.
  //
  // Deliberately narrow, and the wording says so: this proves something was
  // captured, not that the workaround works. Nothing here can check the second,
  // and claiming it would be a gate reporting on what it did not do — the same
  // boundary invariant 5 draws around PASS.
  if (to === 'answered') {
    const dir = issueDir(meta.home ?? resolveHome(), issue);
    if (!(await hasCapture(join(dir, 'validation')))) {
      return {
        ok: false,
        from,
        to,
        error:
          `issue ${issue} has nothing captured, so there is no answer to publish yet.\n` +
          `  Run the reproduction and the workaround, and attach them:\n` +
          `    pdkit validate attach --issue ${issue} --title "<what this step shows>" --run "<command>"\n` +
          `  Steps that were reasoned about rather than run are how a workaround costs a reporter an evening.`,
      };
    }

    if (!meta.reason?.trim()) {
      return {
        ok: false,
        from,
        to,
        error: `issue ${issue}: --reason is required — what the answer is, in one line, for the reader who finds this state in six months`,
      };
    }
  }

  // Going back to triage from a published pull request is a rework, and it is
  // the one transition whose reason cannot be reconstructed from anything else
  // on disk: the diff still exists, the pull request is still open, and only
  // this line says why the work is being done again.
  const rework = to === 'triaged' && (from === 'pr-open' || from === 'review-in-progress');
  if (rework && !meta.reason?.trim()) {
    return {
      ok: false,
      from,
      to,
      error:
        `issue ${issue}: a rework needs --reason "<what the review rejected>".\n` +
        `  The pull request stays open and the branch stays as it is; what changes is that planning runs again.`,
    };
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
    // A rework thaws the requirement set. The identifiers themselves are never
    // renumbered — an R-ID means one thing forever — but a set frozen against a
    // design the reviewer refused has to be able to grow: their objection is
    // usually a requirement nobody had written down.
    requirements: rework ? { ...record.requirements, frozen: false } : record.requirements,
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
 * lost, and later readers — audit, preflight, a person six weeks on — need to
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
      adopted: { at, state: input.state, reason: input.reason.trim(), pr: input.pr ?? null, branch: input.branch ?? null },
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
    { ...record, requirements: { ...record.requirements, ids: [...record.requirements.ids, `R${value}`], next: value + 1, frozen: false } },
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

/** The number of an R-ID. */
const numberOf = (id) => Number.parseInt(id.slice(1), 10);

/**
 * What an amendment's requirement table does to a requirement set, computed and
 * not written.
 *
 * Separate from amendRequirements so `amendment approve` can ask before it
 * rewrites the amendment's status: an amendment recorded as approved whose
 * table then turns out not to apply is a decision on disk that the record
 * contradicts, and the cheapest way not to produce one is to refuse first.
 *
 * The rules are the ones the template's comment states. A withdrawn, superseded
 * or replaced R-ID leaves the live set and keeps its number — nothing is ever
 * renumbered. An added one continues the numbering from `next`, with no gap and
 * no reuse: an R-ID that was ever allocated means that requirement forever,
 * including after it was withdrawn. A requirement given way to (`superseded by
 * R8`) has to be in the set the amendment produces, or the sentence points at
 * nothing.
 *
 * `reflected` is the set already saying what the table says — every added ID
 * present, every removed one gone. That is what an amendment applied by hand
 * looks like (18915, A1, through `node -e`), and applying it again would refuse
 * on its own added IDs.
 *
 * @param {{ids: string[], next: number}} requirements
 * @param {Array<import('./artefacts.js').RequirementChange>} rows
 * @returns {{ok: boolean, problems: string[], before: string[], after: string[], next: number, added: string[], removed: string[], reflected: boolean}}
 */
export function amendedRequirements(requirements, rows) {
  const before = [...(requirements.ids ?? [])];
  const next = requirements.next ?? 1;
  const problems = [];
  const outcome = (fields) => ({ ok: problems.length === 0, problems, before, after: before, next, added: [], removed: [], reflected: false, ...fields });

  for (const row of rows) {
    if (row.problem) problems.push(`line ${row.line}: ${row.problem}`);
  }
  if (problems.length > 0) return outcome();

  const named = new Map();
  for (const row of rows) {
    for (const id of row.ids) {
      if (named.has(id)) problems.push(`line ${row.line}: ${id} is already on line ${named.get(id)} — one row per requirement`);
      else named.set(id, row.line);
    }
  }

  const of = (...kinds) => rows.filter((row) => kinds.includes(row.change)).flatMap((row) => row.ids);
  const added = of('added').sort((a, b) => numberOf(a) - numberOf(b));
  const removed = of('withdrawn', 'superseded', 'replaced').sort((a, b) => numberOf(a) - numberOf(b));
  const unchanged = of('unchanged');

  const reflected =
    problems.length === 0 &&
    added.length + removed.length > 0 &&
    added.every((id) => before.includes(id) && numberOf(id) < next) &&
    // Gone because it was allocated and taken out, not because it never was.
    removed.every((id) => !before.includes(id) && numberOf(id) < next) &&
    unchanged.every((id) => before.includes(id));
  if (reflected) return outcome({ reflected: true, added, removed });

  for (const row of rows) {
    if (row.change === 'added') continue;
    for (const id of row.ids) {
      if (!before.includes(id)) problems.push(`line ${row.line}: ${id} is "${row.wrote}", and the issue's live set (${before.join(', ') || 'empty'}) has no ${id}`);
    }
  }

  // Numbering continues from the counter: the first added ID is `next`, and
  // each one after it is the one after that.
  for (const [index, id] of added.entries()) {
    const expected = `R${next + index}`;
    if (id === expected) continue;
    problems.push(
      numberOf(id) < next
        ? `${id} is added, and R1 to R${next - 1} were allocated already — an R-ID means one requirement forever, including after it is withdrawn`
        : `${id} is added where ${expected} comes next — new R-IDs continue the numbering without a gap`,
    );
    break;
  }

  const after = [...before.filter((id) => !removed.includes(id)), ...added];
  for (const row of rows) {
    if (!row.by) continue;
    if (row.ids.includes(row.by)) problems.push(`line ${row.line}: ${row.by} cannot be ${row.wrote.toLowerCase()} itself`);
    else if (!after.includes(row.by)) {
      problems.push(`line ${row.line}: ${row.ids.join(', ')} gives way to ${row.by}, which is not in the set this amendment produces`);
    }
  }

  if (problems.length > 0) return outcome();
  return outcome({ after, next: next + added.length, added, removed });
}

/**
 * Apply an approved amendment's requirement table to the issue's set.
 *
 * The one write to a frozen set, and why it exists: an approved amendment that
 * adds R7 and withdraws R2 changes what the plan requires, and a set that could
 * not follow left 18915 holding R1–R6 for twenty hours after A1 was approved —
 * `slice set` refused because withdrawn requirements reached no slice, and the
 * fix was `node -e` on this file, the thing the module header says never happens.
 *
 * It takes the amendment's ID and nothing else, and reads the table from the
 * amendment file itself, which has to say `approved`. That is what keeps this
 * from being a way around the freeze: there is no argument through which a
 * caller can hand it a set, only the name of a decision already on disk. Each
 * application is journalled as `requirements-amended` with the set before and
 * after — a freeze that can be lifted without a trace does not protect anything.
 *
 * Applied once. The record keeps the IDs of the amendments it has taken, and a
 * second call is answered `already` without writing.
 *
 * @param {number} issue
 * @param {{amendment: string, home?: string}} options
 * @returns {Promise<{ok: boolean, error?: string, problems?: string[], already?: boolean, reflected?: boolean, before?: string[], after?: string[], added?: string[], removed?: string[]}>}
 */
export async function amendRequirements(issue, options) {
  const id = String(options?.amendment ?? '').trim().toUpperCase();
  if (!/^A\d+$/.test(id)) {
    return { ok: false, error: `the requirements of issue ${issue} change after freezing only through an approved amendment, and none was named` };
  }

  // Imported here rather than at the top: artefacts.js reaches gate.js through
  // render.js and gh.js, and gate.js imports this module.
  const { parseAmendment } = await import('./artefacts.js');

  const path = join(issueDir(options.home ?? resolveHome(), issue), 'amendments', `${id}.md`);
  let amendment;
  try {
    amendment = parseAmendment(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, error: `issue ${issue} has no ${id} (${path})` };
    throw error;
  }
  if (amendment.id !== id) return { ok: false, error: `${path} is not ${id}: its title says ${amendment.id || 'nothing readable'}` };
  if (amendment.status !== 'approved') {
    return {
      ok: false,
      error: `${id} is ${amendment.status || 'in no recognised status'}, not approved — the requirement set moves when an amendment is approved, by \`pdkit amendment approve\``,
    };
  }

  const record = await read(issue, options);
  const applied = record.requirements.amendments ?? [];
  if (applied.includes(id)) {
    return { ok: true, already: true, before: record.requirements.ids, after: record.requirements.ids, added: [], removed: [] };
  }
  if (amendment.requirements.length === 0) return { ok: true, before: record.requirements.ids, after: record.requirements.ids, added: [], removed: [] };
  if (record.route === 'quickfix') {
    return { ok: false, error: `issue ${issue} is on the quickfix route: it has no R-IDs for ${id} to change` };
  }

  const result = amendedRequirements(record.requirements, amendment.requirements);
  if (!result.ok) return { ok: false, error: `${id} cannot be applied to the requirements of issue ${issue}`, problems: result.problems };

  await save(
    { ...record, requirements: { ...record.requirements, ids: result.after, next: result.next, amendments: [...applied, id] } },
    options,
  );

  const changes = [
    result.added.length ? `added ${result.added.join(',')}` : '',
    result.removed.length ? `removed ${result.removed.join(',')}` : '',
  ].filter(Boolean);
  await appendJournal(
    {
      issue,
      event: 'requirements-amended',
      detail: result.reflected
        ? `${id} — already reflected in the record, now recorded as applied: ${result.after.join(',') || 'none'}`
        : `${id} — ${result.before.join(',') || 'none'} → ${result.after.join(',') || 'none'}${changes.length ? ` (${changes.join('; ')})` : ''}`,
    },
    options,
  );

  return { ok: true, reflected: result.reflected, before: result.before, after: result.after, added: result.added, removed: result.removed };
}

/** Counters an issue hands out numbers from. */
export const COUNTERS = ['task', 'slice', 'amendment', 'validation', 'deferral'];

/** The largest number among names like `T6.md`, or 0. */
function highestNamed(names, pattern) {
  let highest = 0;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return highest;
}

async function namesIn(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * The highest number of this kind that already exists on disk, or 0.
 *
 * Read here because the counter is not the only writer of these names. /pd:plan
 * writes tasks/T*.md directly and the slicer numbers the graph itself, so on
 * DESKTOP-18915 the task counter stood at 3 beside T1..T6, and `ids task`
 * handed out T2 — a live task. What is on disk is what a new ID must not
 * collide with; the counter only remembers numbers that were spent and since
 * vanished.
 *
 * The graph and the validation record are read through the modules that own
 * them, imported when needed: both import this one. A record that does not
 * parse refuses the allocation rather than reading as empty.
 *
 * @param {number} issue
 * @param {'task'|'slice'|'amendment'|'validation'|'deferral'} kind
 * @param {{home?: string}} options
 * @returns {Promise<number>}
 */
async function highestOnDisk(issue, kind, options) {
  const dir = issueDir(options.home ?? resolveHome(), issue);

  switch (kind) {
    case 'task':
      return highestNamed(await namesIn(join(dir, 'tasks')), /^T(\d+)\.md$/);
    case 'amendment':
      return highestNamed(await namesIn(join(dir, 'amendments')), /^A(\d+)\.md$/);
    case 'deferral':
      return highestNamed(await namesIn(join(dir, 'deferrals')), /^D(\d+)\.md$/);
    case 'slice': {
      const graph = await (await import('./slice.js')).read(issue, options);
      const indices = (graph?.slices ?? []).map((slice) => slice?.index).filter(Number.isInteger);
      return Math.max(0, ...indices);
    }
    case 'validation': {
      const record = await (await import('./validation.js')).read(issue, options);
      const steps = (record?.steps ?? []).map((step) => `${step?.id}.md`);
      return Math.max(
        highestNamed(steps, /^V(\d+)\.md$/),
        highestNamed(await namesIn(join(dir, 'validation')), /^V(\d+)\.md$/),
      );
    }
    default:
      return 0;
  }
}

/**
 * Allocate the next task, slice, amendment, validation or deferral number.
 *
 * The number is the larger of the counter and one past the highest of its kind
 * on disk. A skipped number is a gap; a reused one makes two things answer to
 * the same name, and every reference to it ambiguous.
 *
 * @param {number} issue
 * @param {'task'|'slice'|'amendment'|'validation'|'deferral'} kind
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: boolean, value?: number, error?: string}>}
 */
export async function allocateCounter(issue, kind, options = {}) {
  if (!COUNTERS.includes(kind)) return { ok: false, error: `unknown counter "${kind}" (${COUNTERS.join(', ')})` };

  const record = await read(issue, options);
  // A record written before a counter existed has no field for it, and falling
  // through to undefined would produce `A undefined`.
  const value = Math.max(record.counters[kind] ?? 1, (await highestOnDisk(issue, kind, options)) + 1);
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
 * Take a task out of the plan: record why, and drop what it owned.
 *
 * The ownership goes in the same write, because a withdrawn task that still
 * owns its files is two claims on one file for the rest of the cycle — on 18915
 * `owns.T2` kept updater.ts after A1 said nobody touches it. The ID stays, in
 * `withdrawn`, so the pre-write hook, `task start` and the audit can each say
 * the task was withdrawn rather than that it was never planned.
 *
 * Writing the same withdrawal again changes nothing.
 *
 * @param {number} issue
 * @param {{task: string, amendment: string|null, replacedBy?: string[], home?: string}} input
 * @returns {Promise<{changed: boolean, owned: string[]|null}>}  `owned` is what the task held before
 */
export async function withdrawTask(issue, input) {
  const record = await read(issue, input);
  const was = record.withdrawn?.[input.task];
  const replacedBy = input.replacedBy ?? [];
  const owned = record.owns?.[input.task] ?? null;

  if (was && owned === null && was.amendment === input.amendment && was.replacedBy.join() === replacedBy.join()) {
    return { changed: false, owned: null };
  }

  const { [input.task]: _dropped, ...owns } = record.owns ?? {};
  await save(
    {
      ...record,
      owns,
      withdrawn: { ...record.withdrawn, [input.task]: { amendment: input.amendment, replacedBy, at: was?.at ?? new Date().toISOString() } },
    },
    input,
  );
  return { changed: true, owned };
}

/**
 * Issues still in progress whose record was written after an instant, newest
 * first.
 *
 * The question it answers is whether a working tree's branch can still be read
 * as "the issue being worked on". Nothing returns a checkout to where it was,
 * so a branch is wherever the last piece of work left it; `updatedAt` is only
 * written by commands that change an issue's record, so a later one elsewhere
 * is a fact that the work moved on. Found on DESKTOP-18915, whose whole cycle
 * ran in a main checkout left on 18967's branch: SessionStart told every
 * session it was 18967's, and SubagentStop filed every subagent under 18967.
 *
 * Read-only, and an unreadable record is skipped rather than thrown: it is not
 * evidence of anything here, and doctor is where problems are reported.
 *
 * @param {string|null} since ISO 8601; null answers nothing
 * @param {{home?: string, except?: number}} [options]
 * @returns {Promise<Record_[]>}
 */
export async function movedSince(since, options = {}) {
  if (!since) return [];
  const home = options.home ?? resolveHome();

  let entries;
  try {
    entries = await readdir(paths(home).issues);
  } catch {
    return [];
  }

  const later = [];
  for (const entry of entries) {
    const issue = Number.parseInt(entry, 10);
    if (!Number.isInteger(issue) || issue === options.except) continue;

    let record;
    try {
      record = await read(issue, { home });
    } catch {
      continue;
    }
    if (!record.createdAt || (TRANSITIONS[record.state] ?? []).length === 0) continue;
    if (!record.updatedAt || record.updatedAt <= since) continue;
    later.push(record);
  }

  return later.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
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

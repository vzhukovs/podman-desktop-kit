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

// Validation as an entity (spec section 2.2, invariant 5).
//
// INVARIANT: this module is the only writer of
// $PDKIT_HOME/issues/<n>/validation.json, and validation.md is rendered from
// it. The status of a step is DERIVED from what is attached to it — there is no
// `status` parameter anywhere below, which is the same shape that made receipts
// and slice verification worth reading.
//
// The boundary is narrower than the one slice verification gets, and saying so
// is the point. A slice's verdict is machine-readable all the way down: it is
// an exit code. "The contrast is now 4.6:1" is an observation, and no code here
// can confirm it was read correctly. So PASS promises an attached artefact and
// nothing more. Promising that the application behaves would buy a check that
// reports on work it did not do — the same failure as a `pass` where a `skip`
// belonged.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { parsePlan } from './artefacts.js';
import { get, issueDir, resolveHome } from './config.js';
import { capture, digest, writeReceipt } from './evidence.js';
import { append as appendJournal } from './journal.js';
import { write as writeArtefact } from './render.js';
import { pickScript, relativeToRepo, scripts as repoScripts } from './repo.js';
import { runScript } from './scripts.js';
import { allocateCounter, read as readState, transition } from './state.js';
import * as running from './validation/app.js';

/**
 * What a validation step has to show for itself: a captured run, or a file
 * produced while driving the application.
 *
 * The digest is what makes it evidence rather than a reference. An artefact
 * edited after it was attached stops matching, and the step goes back to
 * proving nothing — which is the whole reason a path alone is not enough.
 *
 * @typedef {object} Evidence
 * @property {'run'|'artefact'} kind    a captured command, or a file produced while driving the app
 * @property {string} path              relative to the issue directory, or to the repository for artefacts
 * @property {string} digest            sha256 over the transcript, or over the file's bytes
 * @property {number|null} bytes
 */

/**
 * One thing that was checked against the running application.
 *
 * There is no status field, and that absence is the invariant: the outcome is
 * derived from `evidence` and `exitCode` by `statusOf`, so there is no input
 * through which "it worked" can be asserted rather than shown.
 *
 * `superseded` is the one way a step stops counting towards the outcome, and it
 * is a record rather than a deletion: the step, its run and its reason all stay.
 *
 * @typedef {object} Step
 * @property {string} id                V1, V2, …
 * @property {string[]} requirements    the R-IDs this step demonstrates; often two or three
 * @property {string} title
 * @property {string|null} expected
 * @property {string|null} observed
 * @property {Evidence|null} evidence
 * @property {number|null} exitCode     only for kind: 'run'
 * @property {string} at
 * @property {{by: string, reason: string, at: string}|null} [superseded]
 */

/**
 * The R-IDs of a step, however they were written.
 *
 * A step usually demonstrates more than one requirement — one screenshot of a
 * list showing the column, the sort order and the empty state at once — and the
 * record used to hold exactly one, so the rest were described in prose and
 * traced by nobody. Accepts a list, a comma or space separated string, or
 * nothing.
 *
 * @param {string|string[]|null|undefined} given
 * @returns {string[]}
 */
export function requirementsOf(given) {
  const entries = Array.isArray(given) ? given : [given];

  return [
    ...new Set(
      entries
        .filter((entry) => typeof entry === 'string')
        .flatMap((entry) => entry.split(/[,\s]+/))
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => entry !== ''),
    ),
  ];
}

/**
 * The stability record of a codified e2e test: the same spec, run again and
 * again.
 *
 * `digest` is what keeps it honest. Three green runs against a spec that has
 * since been edited describe a test nobody is shipping, so the digest is
 * compared before the count is trusted, and `consecutive` is counted from the
 * end rather than totalled.
 *
 * @typedef {object} Series
 * @property {string|null} spec         path to the codified test, relative to the repository
 * @property {string|null} digest       sha256 of the spec's contents when the runs happened
 * @property {Array<{at: string, exitCode: number|null, evidence: string}>} runs
 * @property {number} consecutive       green runs in a row, counted from the end
 */

/**
 * Everything validation knows about one issue, in validation.json.
 *
 * `app` is the running application this issue started, kept so `stop` can find
 * it and so a second launch does not fight the first for the debug port. It is
 * cleared on stop; the steps and the series are not.
 *
 * @typedef {object} Record_
 * @property {number} issue
 * @property {string|null} updatedAt
 * @property {Step[]} steps
 * @property {Series} e2e
 * @property {{pid: number, port: number, endpoint: string, binary: string, startedAt: string}|null} app
 */

/** No artefact, no observation: nothing was established about this step. */
export const UNVERIFIED = 'unverified';

/**
 * @param {string} home
 * @param {number} issue
 * @returns {string}
 */
function recordPath(home, issue) {
  return join(issueDir(home, issue), 'validation.json');
}

/**
 * The record an issue has before anything has been validated.
 *
 * Returned rather than written, and spread over whatever is read from disk, so
 * a record saved by an older version gains new fields with their defaults
 * instead of arriving half-shaped.
 *
 * @param {number} issue
 * @returns {Record_}
 */
function blank(issue) {
  return {
    issue,
    updatedAt: null,
    steps: [],
    e2e: { spec: null, digest: null, runs: [], consecutive: 0 },
    app: null,
    // Survives `stop`, unlike `app`. Only used to know whether a Playwright
    // server could be holding the window of an earlier run — see launch().
    launches: 0,
  };
}

/**
 * One step as this version holds it, whichever version wrote it.
 *
 * @param {object} step
 * @returns {Step}
 */
function restore(step) {
  const { requirement, ...rest } = step ?? {};

  return {
    ...rest,
    requirements: requirementsOf(step?.requirements ?? requirement),
    superseded: step?.superseded ?? null,
  };
}

/**
 * Read what has been validated for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Record_|null>} null when validation has not started
 */
export async function read(issue, options = {}) {
  const home = options.home ?? resolveHome();

  let raw;
  try {
    raw = await readFile(recordPath(home, issue), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...blank(issue),
      ...parsed,
      // A record written before a step could carry more than one R-ID keeps its
      // `requirement`, and is read as the list it always meant. Rebuilt rather
      // than spread over, so the singular key does not survive the next save
      // and leave two fields answering the same question.
      steps: (parsed.steps ?? []).map((step) => restore(step)),
      e2e: { ...blank(issue).e2e, ...(parsed.e2e ?? {}) },
    };
  } catch (error) {
    throw new Error(`${recordPath(home, issue)}: the validation record is not readable JSON`, { cause: error });
  }
}

/**
 * Persist. Private, like state.js's and pr.js's: what can happen to this file
 * is the list of exports below and nothing else.
 *
 * @param {Record_} record
 * @param {{home?: string}} options
 * @returns {Promise<Record_>}
 */
async function save(record, options) {
  const home = options.home ?? resolveHome();
  const file = recordPath(home, record.issue);

  const next = { ...record, updatedAt: new Date().toISOString() };

  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file);

  return next;
}

/**
 * The status of one step, derived from what is attached to it.
 *
 * This function is the invariant. Every field it reads is written by capture or
 * by hashing a file on disk, so there is no path from "the agent says it
 * passed" to `pass`.
 *
 * @param {Step} step
 * @returns {'pass'|'fail'|'observed'|'unverified'}
 */
export function statusOf(step) {
  if (!step.evidence) return UNVERIFIED;
  if (step.evidence.kind === 'run') return step.exitCode === 0 ? 'pass' : 'fail';
  // An artefact with nothing said about it is a file, not a finding. Requiring
  // the observation here rather than at the call site means a screenshot
  // attached and never described cannot quietly count as evidence.
  return step.observed ? 'observed' : UNVERIFIED;
}

/** Worst first. The outcome of a validation is the most serious thing in it. */
const SEVERITY = ['fail', UNVERIFIED, 'observed', 'pass'];

/**
 * The outcome of the whole validation.
 *
 * `observed` steps roll up into `pass`: an artefact plus a description of what
 * it shows is evidence, and demanding a runnable assertion for every visual
 * check would make the honest path the expensive one. What does not roll up is
 * a step with nothing attached — see section 4 for why that is `unverified`
 * rather than a refusal.
 *
 * @param {Record_|null} record
 * @returns {{outcome: 'pass'|'fail'|'unverified'|'empty', gaps: Step[]}}
 */
export function outcomeOf(record) {
  const all = record?.steps ?? [];
  if (all.length === 0) return { outcome: 'empty', gaps: [] };

  // A superseded step is still in the record and no longer in the arithmetic.
  // That is the whole difference between setting a step aside and editing it
  // out: the run, the reason and the step that replaced it stay readable.
  const steps = all.filter((step) => !step.superseded);
  if (steps.length === 0) return { outcome: 'empty', gaps: [] };

  const statuses = steps.map((step) => statusOf(step));
  const gaps = steps.filter((step) => statusOf(step) === UNVERIFIED);
  const worst = SEVERITY.find((status) => statuses.includes(status)) ?? 'pass';

  return { outcome: worst === 'observed' ? 'pass' : worst, gaps };
}

/**
 * Set one step aside in favour of another that demonstrated the same thing.
 *
 * The case this exists for, from a live run: `validate launch` started the
 * application, the e2e spec then refused to start a second Electron instance —
 * `An instance of Podman Desktop is already running` — and not one test
 * executed. The same spec passed four times in a row once the window was
 * closed. The record held a red step about the environment, `finish` takes the
 * worst status in it, and there was nothing to do about it except edit
 * `validation.json` by hand, which is exactly what the design exists to
 * prevent. A step that cannot be removed and cannot be corrected leaves editing
 * the record as the only way forward, and then the record is worth less than
 * the file it is in.
 *
 * What keeps this from being a way of typing PASS:
 *
 *   - the replacement must have demonstrated something itself — a run that
 *     passed, or an artefact with an observation. A step cannot be set aside in
 *     favour of one that shows nothing;
 *   - a step that passed cannot be superseded, because there is nothing to set
 *     aside, and the only use for it would be hiding a pass;
 *   - the reason is required, and it is a sentence a person writes: what made
 *     the step answer about the environment rather than about the change;
 *   - nothing is deleted. The step, its exit code and its evidence stay in
 *     validation.md, marked with what replaced it.
 *
 * @param {{issue: number, step: string, by: string, reason: string, home?: string}} input
 * @returns {Promise<{ok: boolean, step?: Step, by?: Step, note?: string, error?: string}>}
 */
export async function supersede(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  if (!record) return { ok: false, error: `issue ${input.issue} has nothing validated, so there is no step to set aside` };

  const reason = String(input.reason ?? '').trim();
  if (reason === '') {
    return { ok: false, error: 'a reason is required: what made this step answer about the environment rather than about the change' };
  }

  const target = record.steps.find((step) => step.id === input.step);
  if (!target) return { ok: false, error: `${input.step || '(no step)'} is not a step of issue ${input.issue}` };

  const replacement = record.steps.find((step) => step.id === input.by);
  if (!replacement) return { ok: false, error: `${input.by || '(no step)'} is not a step of issue ${input.issue}; --by names the step that replaces it` };
  if (replacement.id === target.id) return { ok: false, error: `${target.id} cannot supersede itself` };

  if (target.superseded) return { ok: false, error: `${target.id} is already superseded by ${target.superseded.by}` };
  if (replacement.superseded) return { ok: false, error: `${replacement.id} is itself superseded by ${replacement.superseded.by}` };

  if (statusOf(target) === 'pass') {
    return { ok: false, error: `${target.id} passed; there is nothing to set aside, and a superseded pass is a pass nobody can find` };
  }

  const status = statusOf(replacement);
  if (status !== 'pass' && status !== 'observed') {
    return {
      ok: false,
      error:
        `${replacement.id} is ${status}: a step is only set aside in favour of one that demonstrated something. ` +
        'Re-run the scenario and attach that run, then supersede with it',
    };
  }

  const superseded = { by: replacement.id, reason, at: new Date().toISOString() };
  const steps = record.steps.map((step) => (step.id === target.id ? { ...step, superseded } : step));
  await save({ ...record, steps }, { home });

  await appendJournal(
    { issue: input.issue, event: 'validation-superseded', detail: `${target.id} superseded by ${replacement.id}: ${reason}` },
    { home },
  );

  // Said rather than refused: the R-IDs of a superseded step stop counting as
  // covered, and losing one silently is how a requirement demonstrated once
  // ends up demonstrated never.
  const dropped = target.requirements.filter((id) => !replacement.requirements.includes(id));

  return {
    ok: true,
    step: { ...target, superseded },
    by: replacement,
    note: dropped.length > 0 ? `${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} on ${target.id} and ${dropped.length === 1 ? 'is' : 'are'} not on ${replacement.id}` : undefined,
  };
}

/**
 * sha256 of a file's bytes.
 *
 * Screenshots are binary, so the transcript digest of lib/evidence.js does not
 * apply; what carries over is why it is taken at all. An artefact that can be
 * swapped after the fact is an artefact that proves the swap, not the run.
 *
 * @param {string} file
 * @returns {Promise<{digest: string, bytes: number}>}
 */
export async function digestFile(file) {
  const bytes = await readFile(file);
  return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length };
}

/**
 * Copy an artefact in beside the record, and hash the copy.
 *
 * The digest is taken over what was stored, not over what was handed in: those
 * are the same bytes now, and the stored one is what anybody will open later.
 *
 * @param {{issue: number, id: string, source: string, home: string}} input
 * @returns {Promise<{path: string, digest: string, bytes: number, from: string}>}
 */
async function keep(input) {
  const bytes = await readFile(input.source);

  const extension = extname(input.source) || '.bin';
  const path = `validation/artefacts/${input.id}${extension}`;
  const target = join(issueDir(input.home, input.issue), path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);

  return {
    path,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.length,
    from: isAbsolute(input.source) ? input.source : resolve(input.source),
  };
}

/**
 * Attach evidence to a validation step, allocating the step if it is new.
 *
 * Note what is not a parameter: the status. `run` produces it through
 * lib/evidence.js, `evidence` produces it by hashing a file that exists. An
 * agent describing what it saw fills `observed`, which is a claim about a real
 * artefact rather than a substitute for one.
 *
 * @param {{issue: number, title: string, requirements?: string|string[]|null, expected?: string|null, observed?: string|null, evidence?: string|null, run?: import('./evidence.js').Capture|null, repoRoot?: string, home?: string}} input
 * @returns {Promise<{ok: boolean, step?: Step, error?: string}>}
 */
export async function attach(input) {
  const home = input.home ?? resolveHome();
  const record = (await read(input.issue, { home })) ?? blank(input.issue);

  if (!input.title) return { ok: false, error: 'a validation step needs a title: what was checked' };

  const allocated = await allocateCounter(input.issue, 'validation', { home });
  if (!allocated.ok) return { ok: false, error: allocated.error };
  const id = `V${allocated.value}`;

  let evidence = null;
  let exitCode = null;

  if (input.run) {
    const written = await writeReceipt({
      issue: input.issue,
      taskId: `${id} ${input.title}`,
      path: `validation/${id}.md`,
      run: input.run,
      home,
    });
    evidence = { kind: 'run', path: `validation/${id}.md`, digest: written.digest, bytes: null };
    exitCode = input.run.exitCode;
  } else if (input.evidence) {
    // Copied in beside the record rather than referenced where it lies. A
    // screenshot taken into a temporary directory is gone by the next reboot,
    // and validation.md would then point confidently at nothing. Found on the
    // first live run, where an artefact outside the repository also produced a
    // path of five `..` segments — accurate, resolvable, and describing the
    // file as though it were part of the fork.
    let stored;
    try {
      stored = await keep({ issue: input.issue, id, source: input.evidence, home });
    } catch (error) {
      // Refusing here rather than recording a path is the whole point: a
      // validation record pointing at a file nobody can open is worse than one
      // that admits the step was never demonstrated.
      return { ok: false, error: `${input.evidence}: cannot be read, so it cannot be evidence (${error.code ?? error.message})` };
    }
    evidence = { kind: 'artefact', path: stored.path, digest: stored.digest, bytes: stored.bytes, from: stored.from };
  }

  const step = {
    id,
    requirements: requirementsOf(input.requirements),
    title: input.title,
    expected: input.expected ?? null,
    observed: input.observed ?? null,
    evidence,
    exitCode,
    at: new Date().toISOString(),
    superseded: null,
  };

  await save({ ...record, steps: [...record.steps, step] }, { home });
  await appendJournal(
    { issue: input.issue, event: 'validation-step', detail: `${id} ${statusOf(step)} — ${step.title}` },
    { home },
  );

  return { ok: true, step };
}

/**
 * Record the codified test a manual scenario became.
 *
 * The digest is taken here and re-taken by preflight. A series of green runs
 * against a spec that has since been edited is the same stale proof that the
 * slice diff digest exists to catch (spec decision 23).
 *
 * @param {{issue: number, spec: string, repoRoot: string, home?: string}} input
 * @returns {Promise<{ok: boolean, record?: Record_, error?: string, digest?: string}>}
 */
export async function codify(input) {
  const home = input.home ?? resolveHome();
  const record = (await read(input.issue, { home })) ?? blank(input.issue);

  const file = isAbsolute(input.spec) ? input.spec : join(input.repoRoot, input.spec);
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `${input.spec}: ${error.code === 'ENOENT' ? 'no such file in the repository' : error.message}` };
  }

  // Forward slashes, on every platform. `relative()` answers in the platform's
  // separators, and this value is stored and then compared against a path git
  // produced — `e2e-stability` asks whether the diff contains `record.e2e.spec`,
  // and git always says `tests/playwright/…`. On Windows the two could never
  // match, so a recorded series was reported as being for a different file than
  // the one being shipped, every time.
  const spec = relativeToRepo(input.repoRoot, file);
  const specDigest = digest(contents);

  // Changing the spec invalidates the series rather than keeping it: runs
  // recorded against different contents did not exercise this test.
  const same = record.e2e.spec === spec && record.e2e.digest === specDigest;
  const saved = await save(
    { ...record, e2e: same ? record.e2e : { spec, digest: specDigest, runs: [], consecutive: 0 } },
    { home },
  );

  return { ok: true, record: saved, digest: specDigest };
}

/**
 * Append one run of the codified test.
 *
 * `consecutive` counts from the end, so a red run in the middle of a series
 * resets it. That is what "three times in a row" means, and counting greens
 * anywhere in the history would let a flaky test qualify by being run enough
 * times.
 *
 * @param {{issue: number, run: import('./evidence.js').Capture, index: number, home?: string}} input
 * @returns {Promise<{ok: boolean, record?: Record_, evidence?: string, written?: {path: string, digest: string}, error?: string}>}
 */
export async function recordRun(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  if (!record?.e2e.spec) return { ok: false, error: 'no e2e candidate is registered; run pdkit validate codify first' };

  const path = `validation/e2e-${input.index}.md`;
  const written = await writeReceipt({
    issue: input.issue,
    taskId: `e2e run ${input.index} (${basename(record.e2e.spec)})`,
    path,
    run: input.run,
    home,
  });

  const nothing = ranNothing(input.run, record.e2e.spec);
  const runs = [
    ...record.e2e.runs,
    // `executed` is written only when the run is known to have executed
    // nothing. Absent means the question was never asked, which is what every
    // entry recorded before this check says, and `streak` reads it that way.
    { at: input.run.at, exitCode: input.run.exitCode, evidence: path, ...(nothing ? { executed: false } : {}) },
  ];

  const saved = await save({ ...record, e2e: { ...record.e2e, runs, consecutive: streak(runs) } }, { home });
  return { ok: true, record: saved, evidence: path, written, ranNothing: nothing };
}

/**
 * How many runs at the end of the series were green, most recent first.
 *
 * Green is an exit code of zero AND a run that executed something. The second
 * half is not pedantry: a suite whose every test skipped exits zero, and three
 * of those satisfy the check that exists to stop a flake reaching somebody
 * else's repository.
 *
 * @param {Array<{exitCode: number|null, executed?: boolean}>} runs
 * @returns {number}
 */
function streak(runs) {
  let consecutive = 0;
  for (const entry of [...runs].reverse()) {
    if (entry.exitCode !== 0 || entry.executed === false) break;
    consecutive += 1;
  }
  return consecutive;
}

/**
 * Whether the recorded series still describes the spec as it stands.
 *
 * @param {{issue: number, repoRoot: string, home?: string, record?: Record_|null}} input
 * @returns {Promise<{fresh: boolean, reason?: string, spec?: string, digest?: string, expected?: string}>}
 */
export async function seriesFreshness(input) {
  const record = input.record ?? (await read(input.issue, input));
  if (!record?.e2e.spec) return { fresh: false, reason: 'no e2e candidate is registered' };

  const file = join(input.repoRoot, record.e2e.spec);
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch {
    return { fresh: false, reason: `${record.e2e.spec} is no longer in the repository`, spec: record.e2e.spec };
  }

  const current = digest(contents);
  if (current !== record.e2e.digest) {
    return {
      fresh: false,
      reason: `${record.e2e.spec} changed after the runs were recorded`,
      spec: record.e2e.spec,
      digest: current,
      expected: record.e2e.digest ?? undefined,
    };
  }

  return { fresh: true, spec: record.e2e.spec, digest: current };
}

/**
 * Record — or clear — the application this issue has running under CDP.
 *
 * @param {{issue: number, app: Record_['app'], home?: string}} input
 * @returns {Promise<Record_>}
 */
export async function setApp(input) {
  const home = input.home ?? resolveHome();
  const record = (await read(input.issue, { home })) ?? blank(input.issue);
  return save({ ...record, app: input.app }, { home });
}

// Starting and stopping the application live in lib/validation/app.js. Both
// read and store the record and cannot import that from here without a cycle,
// so the names callers know are kept and hand it over — save() included, which
// is how validation.json keeps this file as its one writer.
const records = { read, blank, save };
export { trustedApp, resolveBinary, alive, displayProblem } from './validation/app.js';
export const launch = (input) => running.launch(input, records);
export const stop = (input) => running.stop(input, records);

/**
 * What is waiting to be validated, and what has been so far.
 *
 * Facts, not a plan of action: which requirements exist, what each task said it
 * would be done by, what the plan decided about e2e coverage. The scenarios
 * themselves are the agent's to write — a checklist derived mechanically from
 * `Done when` would be the tests over again, and the point of this phase is the
 * part a test does not reach.
 *
 * @param {{issue: number, home?: string, repoRoot?: string}} input
 * @returns {Promise<{issue: number, state: string, route: string|null, requirements: string[], frozen: boolean, tasks: Array<{id: string, title: string, satisfies: string[], command: string|null}>, e2eCoverage: string|null, covered: string[], record: Record_|null}>}
 */
export async function steps(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  const stateRecord = await readState(input.issue, { home });

  let plan = null;
  try {
    plan = parsePlan(await readFile(join(issueDir(home, input.issue), 'plan.md'), 'utf8'));
  } catch {
    // No plan is the quickfix route, and it is not a problem to report here:
    // tracing goes by issue number there (section 4), so there is simply
    // nothing to line the steps up against.
  }

  return {
    issue: input.issue,
    state: stateRecord.state,
    route: stateRecord.route ?? null,
    requirements: stateRecord.requirements?.ids ?? [],
    frozen: Boolean(stateRecord.requirements?.frozen),
    tasks: (plan?.tasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      satisfies: task.satisfies,
      command: task.command,
    })),
    e2eCoverage: plan?.e2eCoverage ?? null,
    covered: [...new Set((record?.steps ?? []).filter((step) => !step.superseded).flatMap((step) => step.requirements))],
    record,
  };
}

/** A positional path in a script's command line — `tests/playwright/src/…`. */
const SCRIPT_PATH = /(^|\s)(?!-)[\w.@][\w.@-]*\/\S*/;

/**
 * The command that runs the codified test, and only it.
 *
 * Script names are still resolved from the repository rather than hardcoded
 * (section 7). What changed is the assumption underneath: appending a spec path
 * to a suite script does not narrow the run if that script already carries a
 * path of its own.
 *
 * podman-desktop's `test:e2e:run` is
 * `… npx playwright test tests/playwright/src/specs/ --grep-invert @k8s_e2e`,
 * so appending our file gave Playwright two positional filters and it ran all
 * forty-four specs. Three stability runs became three full suites — found by a
 * run that was still going after ten minutes, against a spec that takes three
 * seconds on its own. The damage is not the time: `validate run` was calling
 * that the evidence for one step, and a check that reports on something other
 * than what it measured is the failure this plugin is built to refuse.
 *
 * So, in order: a configured single-spec command wins; otherwise, a repository
 * with a Playwright configuration gets the runner invoked directly; otherwise
 * the resolved script is used, but only when it carries no path of its own.
 * When none of those hold the answer is an error, because a command that runs
 * the whole suite while claiming to run one spec is worse than no command.
 *
 * @param {{repoRoot: string, config?: object, spec: string}} input
 * @returns {Promise<{command: string|null, script?: string, error?: string}>}
 */
export async function specCommand(input) {
  const config = input.config ?? {};
  const manager = String(get(config, 'repo.package_manager') ?? 'pnpm');

  // An explicit template wins over anything inferred. `{spec}` is where the
  // path goes; a template without it would run the same thing every time.
  const template = get(config, 'preflight.scripts.e2e_spec');
  if (typeof template === 'string' && template.includes('{spec}')) {
    return { command: template.replace('{spec}', input.spec), script: null };
  }

  const available = await repoScripts(input.repoRoot);
  const configured = get(config, 'preflight.scripts.e2e');
  const candidates = Array.isArray(configured) && configured.length > 0 ? configured : ['test:e2e:run', 'test:e2e'];
  const script = pickScript(available, candidates);

  if (await hasPlaywright(input.repoRoot)) {
    return { command: `${manager} exec playwright test ${input.spec}`, script: null, runner: 'playwright' };
  }

  if (!script) {
    return {
      command: null,
      error:
        `no e2e script in this repository (looked for ${candidates.join(', ')}). ` +
        'A validation that ran nothing must not report green',
    };
  }

  if (SCRIPT_PATH.test(String(available[script] ?? ''))) {
    return {
      command: null,
      script,
      error:
        `${script} already names its own path (${String(available[script]).trim()}), so appending a spec widens the ` +
        'run instead of narrowing it — every spec in that path would run and be reported as this one. Set ' +
        'preflight.scripts.e2e_spec to a command containing {spec}',
    };
  }

  return { command: `${runScript({ config }, script)} ${input.spec}`, script };
}

/**
 * The counts a test runner prints when it stops: `12 passed`, `3 skipped`.
 *
 * Deliberately not anchored to Playwright's exact summary. Every runner in
 * reach prints these words next to a number at the end, and a rule that reads
 * the whole capture is one that keeps working when the reporter changes.
 */
const OUTCOME = /(\d+)\s+(passed|failed|flaky|skipped|did not run)\b/gi;

/**
 * Whether a run that exited zero actually executed anything.
 *
 * The one thing an exit code cannot say. A spec gated on an environment
 * variable — `test.skip(process.env.TEST_PODMAN_MACHINE !== 'true')`, which is
 * how this repository gates every machine test — skips its whole body and exits
 * **0**, so a stability series invoked without that variable records three
 * green runs in which no test ran, and the blocking `e2e-stability` check then
 * passes on evidence of nothing. Found on the first multi-slice live run,
 * before it could happen, and recorded as a deferral against this file.
 *
 * "Executed" means passed or flaky. Failed is caught by the exit code; skipped
 * is exactly the case this exists to see.
 *
 * A capture with no recognisable summary returns null: no claim either way,
 * because reporting "nothing ran" from a reporter this does not understand
 * would fail runs that were fine.
 *
 * @param {string} output   stdout and stderr of the run
 * @returns {{executed: number, skipped: number}|null} null when nothing was recognised
 */
export function outcomes(output) {
  let executed = 0;
  let skipped = 0;
  let seen = false;

  for (const match of String(output ?? '').matchAll(OUTCOME)) {
    const count = Number(match[1]);
    const word = match[2].toLowerCase();
    seen = true;
    if (word === 'passed' || word === 'flaky') executed += count;
    else if (word === 'skipped' || word === 'did not run') skipped += count;
    else executed += count;
  }

  return seen ? { executed, skipped } : null;
}

/**
 * The reason a green run proves nothing, or null when it proves something.
 *
 * @param {{exitCode: number|null, stdout?: string, stderr?: string}} run
 * @param {string} spec
 * @returns {string|null}
 */
function ranNothing(run, spec) {
  if (run.exitCode !== 0) return null;

  const counted = outcomes(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  if (!counted || counted.executed > 0) return null;

  return (
    `the run exited 0 with no test executed${counted.skipped > 0 ? ` (${counted.skipped} skipped)` : ''}. ` +
    `${spec} is gated on something this environment does not satisfy — a platform, or an environment variable ` +
    'the suite reads. Set it and run the series again; a green run that ran nothing is not a green run'
  );
}

/**
 * Whether the repository drives Playwright directly.
 *
 * @param {string} repoRoot
 * @returns {Promise<boolean>}
 */
async function hasPlaywright(repoRoot) {
  for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']) {
    try {
      await readFile(join(repoRoot, name));
      return true;
    } catch {
      // Next candidate.
    }
  }
  return false;
}

/**
 * Run the codified test once and record it as the evidence for a step.
 *
 * This is what makes PASS mean something here. A screenshot shows what one
 * person saw once; the run is what CI will repeat on every pull request that
 * follows, which is section 8.1's argument for why `Done when` gets stronger
 * when e2e is possible at all.
 *
 * @param {{issue: number, repoRoot: string, spec?: string, requirements?: string|string[]|null, config?: object, home?: string, timeoutMs?: number}} input
 * `run` is the capture itself, for a caller that has to say how it went. It is
 * not printed whole by anyone: the step's evidence file holds it.
 *
 * @returns {Promise<{ok: boolean, step?: Step, exitCode?: number|null, run?: import('./evidence.js').Capture, error?: string}>}
 */
export async function runSpec(input) {
  const home = input.home ?? resolveHome();

  if (input.spec) {
    const codified = await codify({ issue: input.issue, spec: input.spec, repoRoot: input.repoRoot, home });
    if (!codified.ok) return { ok: false, error: codified.error };
  }

  const record = await read(input.issue, { home });
  if (!record?.e2e.spec) return { ok: false, error: 'no e2e candidate is registered; pass --spec or run pdkit validate codify first' };

  const resolved = await specCommand({ repoRoot: input.repoRoot, config: input.config, spec: record.e2e.spec });
  if (!resolved.command) return { ok: false, error: resolved.error };

  const run = await capture({ command: resolved.command, cwd: input.repoRoot, timeoutMs: input.timeoutMs });

  const attached = await attach({
    issue: input.issue,
    home,
    title: `e2e: ${record.e2e.spec}`,
    requirements: input.requirements ?? null,
    expected: 'the codified scenario passes',
    run,
  });
  if (!attached.ok) return { ok: false, error: attached.error };

  // The same run counts towards the stability series. Recorded rather than
  // re-run: three runs mean three executions, not three ways of counting one.
  const nothing = ranNothing(run, record.e2e.spec);
  const runs = [
    ...record.e2e.runs,
    { at: run.at, exitCode: run.exitCode, evidence: attached.step.evidence.path, ...(nothing ? { executed: false } : {}) },
  ];
  const current = await read(input.issue, { home });
  await save({ ...current, e2e: { ...current.e2e, runs, consecutive: streak(runs) } }, { home });

  // The evidence is attached either way — the run happened and is on disk — but
  // it is not reported as a pass. An exit code of zero from a suite that ran
  // nothing is the one green this workflow must never accept.
  if (nothing) return { ok: false, step: attached.step, exitCode: run.exitCode, run, error: nothing };

  return { ok: true, step: attached.step, exitCode: run.exitCode, run };
}

/**
 * @param {Step} step
 * @returns {string}
 */
function evidenceCell(step) {
  if (!step.evidence) return '—';
  const short = step.evidence.digest.slice(0, 14);
  return `\`${step.evidence.path}\` (${short}…)`;
}

/**
 * Placeholder values for templates/validation.md.
 *
 * Every column that carries a verdict is computed here from the record. The
 * only strings that arrive from outside are the ones an agent legitimately
 * writes — what was checked, what was expected, what it saw.
 *
 * @param {Record_} record
 * @param {{stabilityRuns?: number}} [options]
 * @returns {Record<string, unknown>}
 */
export function renderValues(record, options = {}) {
  const { outcome, gaps } = outcomeOf(record);
  const wanted = options.stabilityRuns ?? 3;

  const rows = record.steps.map((step) =>
    [
      '',
      step.id,
      step.requirements.join(', ') || '—',
      step.title,
      step.expected ?? '—',
      step.observed ?? '—',
      evidenceCell(step),
      // The derived status either way, and what replaced it when it was set
      // aside. Printing only "superseded" would hide whether the step that was
      // set aside had failed or shown nothing, which is the part a reviewer of
      // this record is entitled to see.
      step.superseded ? `${statusOf(step)}, set aside for ${step.superseded.by}` : statusOf(step),
      '',
    ].join(' | ').trim(),
  );

  const aside = record.steps.filter((step) => step.superseded);

  const e2e = record.e2e.spec
    ? `${record.e2e.spec} — ${record.e2e.consecutive}/${wanted} consecutive green`
    : 'no candidate';

  const detail = record.e2e.spec
    ? [
        `- Spec: \`${record.e2e.spec}\``,
        `- Digest: \`${record.e2e.digest}\``,
        `- Runs: ${record.e2e.runs.length}, ${record.e2e.consecutive} green in a row (needs ${wanted})`,
        ...record.e2e.runs.map((run) => `  - ${run.at} exit ${run.exitCode ?? 'killed'} — \`${run.evidence}\``),
      ].join('\n')
    : '_No e2e candidate was codified. If the plan said `e2e coverage: required`, this is a gap, not a decision._';

  return {
    issue: record.issue,
    outcome,
    stepCount: record.steps.length,
    withEvidence: record.steps.filter((step) => step.evidence).length,
    e2e,
    validatedAt: record.updatedAt ?? 'never',
    steps: rows.length ? rows : ['| — | — | nothing was checked | — | — | — | — |'],
    gaps: gaps.length
      ? gaps.map((step) => `- **${step.id}** ${step.title} — ${step.observed ?? 'no artefact and no observation'}`)
      : '_None: every step above has an artefact._',
    superseded: aside.length
      ? aside.map(
          (step) =>
            `- **${step.id}** ${step.title} (${statusOf(step)}) → **${step.superseded.by}**, ${step.superseded.at}\n` +
            `  - ${step.superseded.reason}`,
        )
      : '_None: every step above counts towards the outcome._',
    e2eDetail: detail,
  };
}

/**
 * Write validation.md from the record.
 *
 * @param {{issue: number, home?: string, stabilityRuns?: number}} input
 * @returns {Promise<{ok: boolean, path?: string, outcome?: string, error?: string}>}
 */
export async function render(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  if (!record) return { ok: false, error: `issue ${input.issue} has no validation record` };

  const path = await writeArtefact({
    issue: input.issue,
    template: 'validation',
    path: 'validation.md',
    home,
    values: renderValues(record, { stabilityRuns: input.stabilityRuns }),
  });

  return { ok: true, path, outcome: outcomeOf(record).outcome };
}

/**
 * Run the codified test N times in a row.
 *
 * A flake carried into someone else's repository is the worst thing this
 * workflow could deliver (section 8.1), and the only way to tell a flake from a
 * test is to run it more than once. Stops at the first red: a series is not
 * "mostly green", and continuing would spend minutes to reach a conclusion the
 * first failure already gave.
 *
 * Each run gets its own artefact rather than one summary. Three runs are three
 * pieces of evidence, and a summary of them would be exactly the retelling that
 * receipts exist to make impossible.
 *
 * @param {{issue: number, repoRoot: string, runs?: number, config?: object, home?: string, timeoutMs?: number}} input
 * `runs` says where each one went; `last` is the final capture, so a caller can
 * show the tail of a red one. Neither is the output itself — that is in the
 * files, and three Playwright runs printed whole were half a megabyte.
 *
 * @returns {Promise<{ok: boolean, consecutive?: number, wanted?: number, performed?: number, error?: string, runs?: Array<{path: string, digest: string, exitCode: number|null, durationMs: number}>, last?: import('./evidence.js').Capture}>}
 */
export async function stability(input) {
  const home = input.home ?? resolveHome();
  const wanted = input.runs ?? Number(get(input.config ?? {}, 'validation.e2e_stability_runs') ?? 3);

  const record = await read(input.issue, { home });
  if (!record?.e2e.spec) return { ok: false, error: 'no e2e candidate is registered; run pdkit validate codify first' };

  const fresh = await seriesFreshness({ issue: input.issue, home, repoRoot: input.repoRoot, record });
  if (!fresh.fresh && fresh.reason?.includes('no longer in the repository')) {
    return { ok: false, error: fresh.reason };
  }

  const resolved = await specCommand({ repoRoot: input.repoRoot, config: input.config, spec: record.e2e.spec });
  if (!resolved.command) return { ok: false, error: resolved.error };

  // The spec may have been edited since the last series. Re-codifying here
  // rather than refusing means the runs about to happen are recorded against
  // what is actually on disk — and it drops the earlier runs, which measured
  // something else.
  await codify({ issue: input.issue, spec: record.e2e.spec, repoRoot: input.repoRoot, home });

  let performed = 0;
  /** @type {Array<{path: string, digest: string, exitCode: number|null, durationMs: number}>} */
  const runs = [];
  let last;

  for (let attempt = 1; attempt <= wanted; attempt += 1) {
    const current = await read(input.issue, { home });
    const run = await capture({ command: resolved.command, cwd: input.repoRoot, timeoutMs: input.timeoutMs });
    performed += 1;
    last = run;

    const recorded = await recordRun({ issue: input.issue, home, index: current.e2e.runs.length + 1, run });
    if (!recorded.ok) return { ok: false, error: recorded.error };
    runs.push({ path: recorded.written.path, digest: recorded.written.digest, exitCode: run.exitCode, durationMs: run.durationMs });

    if (run.exitCode !== 0) {
      return {
        ok: false,
        consecutive: recorded.record.e2e.consecutive,
        wanted,
        performed,
        runs,
        last,
        error: `run ${attempt} of ${wanted} failed (exit ${run.exitCode ?? 'killed'}); a flaky test is not a stable one`,
      };
    }

    // Stopped on the first one rather than after three. Running the same empty
    // suite twice more would spend the time and learn nothing, and the whole
    // series is invalid the moment one run turns out to have executed nothing.
    if (recorded.ranNothing) {
      return {
        ok: false,
        consecutive: recorded.record.e2e.consecutive,
        wanted,
        performed,
        runs,
        last,
        error: `run ${attempt} of ${wanted}: ${recorded.ranNothing}`,
      };
    }
  }

  const final = await read(input.issue, { home });
  return { ok: final.e2e.consecutive >= wanted, consecutive: final.e2e.consecutive, wanted, performed, runs, last };
}

/**
 * Close validation: compute the outcome, write validation.md, move the issue.
 *
 * `unverified` moves the issue anyway, and that is a decision rather than an
 * oversight (section 4). Without Playwright there would otherwise be no way out
 * of `implemented`, and a gate that expensive gets routed around — the same
 * argument that gave slice verification its `inconclusive`. What stops the gap
 * from dissolving is the other end: `validation-evidence` in preflight refuses
 * a pull request whose body does not name it.
 *
 * `fail` does not move it. A red run is a finding about the change, not about
 * the process, and there is nothing to carry forward.
 *
 * @param {{issue: number, home?: string, stabilityRuns?: number, transition?: boolean}} input
 * @returns {Promise<{ok: boolean, outcome?: string, path?: string, gaps?: Step[], moved?: boolean, error?: string, note?: string}>}
 */
export async function finish(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  if (!record) return { ok: false, error: `issue ${input.issue} has nothing validated; nothing to finish` };

  const { outcome, gaps } = outcomeOf(record);
  const rendered = await render({ issue: input.issue, home, stabilityRuns: input.stabilityRuns });

  if (outcome === 'fail') {
    return { ok: false, outcome, path: rendered.path, gaps, moved: false, error: 'a step failed; the change is not validated' };
  }
  if (outcome === 'empty') {
    return { ok: false, outcome, path: rendered.path, gaps, moved: false, error: 'no steps were recorded, so nothing was validated' };
  }

  if (input.transition === false) return { ok: true, outcome, path: rendered.path, gaps, moved: false };

  const moved = await transition(input.issue, 'validated', {
    home,
    reason: `${outcome}${gaps.length ? `, ${gaps.length} step(s) without an artefact` : ''}`,
  });

  return {
    ok: true,
    outcome,
    path: rendered.path,
    gaps,
    moved: moved.ok,
    note: moved.ok
      ? undefined
      : // Not an error: the record stands regardless of where the issue is in
        // the machine, and a validation run on an already-audited issue is a
        // reasonable thing to do.
        moved.error,
  };
}

/**
 * Terminal summary. Same division as lib/audit.js: it reports, it does not
 * grade — the one judgement here is the derived status of each step, and that
 * comes from the artefacts.
 *
 * @param {Record_|null} record
 * @returns {string}
 */
export function format(record) {
  if (!record || record.steps.length === 0) {
    return 'Nothing has been validated yet. `pdkit validate steps` says what is waiting.';
  }

  const { outcome, gaps } = outcomeOf(record);
  const lines = [`Outcome: ${outcome}`, ''];

  for (const step of record.steps) {
    const status = statusOf(step);
    const mark = step.superseded ? '⤳' : status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'observed' ? '📎' : '⚠️';
    lines.push(`  ${mark} ${step.id} ${step.title}`);
    if (step.superseded) lines.push(`     set aside for ${step.superseded.by}: ${step.superseded.reason}`);
    if (step.evidence) lines.push(`     ${step.evidence.kind}: ${step.evidence.path}`);
    else lines.push('     no artefact');
  }

  if (record.e2e.spec) {
    lines.push('', `  e2e: ${record.e2e.spec}, ${record.e2e.consecutive} green in a row`);
  }

  if (gaps.length > 0) {
    lines.push(
      '',
      `${gaps.length} step${gaps.length === 1 ? '' : 's'} without an artefact. This does not stop the transition —`,
      'it has to reach the reviewer instead: name them in Notes for reviewers, or preflight will.',
    );
  }

  return lines.join('\n');
}

/**
 * Whether an artefact file recorded earlier still hashes to what was recorded.
 *
 * Exported for preflight rather than used here: this module records, and the
 * gate checks.
 *
 * @param {{repoRoot: string, home: string, issue: number, step: Step}} input
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function evidenceIntact(input) {
  const step = input.step;
  if (!step.evidence) return { ok: false, reason: 'no artefact' };

  // Both kinds live under the issue now: a run's transcript, and the copy of
  // whatever was attached. Nothing here depends on the repository or on the
  // temporary directory a screenshot was taken into.
  const file = join(issueDir(input.home, input.issue), step.evidence.path);

  try {
    await stat(file);
  } catch {
    return { ok: false, reason: `${step.evidence.path} is gone` };
  }

  if (step.evidence.kind === 'artefact') {
    const { digest: current } = await digestFile(file);
    if (current !== step.evidence.digest) return { ok: false, reason: `${step.evidence.path} changed after it was attached` };
  }

  return { ok: true };
}

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

// Validation as an entity (spec section 2.2, invariant 5) — the part that runs
// the codified e2e test: what is waiting to be validated, the command that runs
// one spec and only it, whether a green run executed anything, and the run
// series that tells a test from a flake.
//
// Reading and saving the record arrive as parameters (Records below): they live
// in lib/validation.js, which re-exports this file and stays the one writer of
// the record, and importing them back would be a cycle.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parsePlan } from '../artefacts.js';
import { get, issueDir, resolveHome } from '../config.js';
import { capture } from '../evidence.js';
import { pickScript, scripts as repoScripts } from '../repo.js';
import { runScript } from '../scripts.js';
import { read as readState } from '../state.js';

/** @typedef {import('../validation.js').Record_} Record_ */
/** @typedef {import('../validation.js').Step} Step */

/**
 * What the e2e run needs from lib/validation.js, handed over by its facade.
 *
 * `save`, `attach`, `codify` and `recordRun` are among them on purpose: the
 * record keeps one writer, and a run is attached and counted through it rather
 * than through a second one.
 *
 * @typedef {object} Records
 * @property {(issue: number, options?: {home?: string}) => Promise<Record_|null>} read
 * @property {(record: Record_, options: {home?: string}) => Promise<Record_>} save
 * @property {(input: object) => Promise<{ok: boolean, step?: Step, error?: string}>} attach
 * @property {(input: object) => Promise<{ok: boolean, record?: Record_, error?: string, digest?: string}>} codify
 * @property {(input: object) => Promise<{ok: boolean, record?: Record_, evidence?: string, written?: {path: string, digest: string}, ranNothing?: string|null, error?: string}>} recordRun
 * @property {(input: object) => Promise<{fresh: boolean, reason?: string}>} seriesFreshness
 * @property {(runs: Array<{exitCode: number|null, executed?: boolean}>) => number} streak
 */

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
 * @param {Records} records
 * @returns {Promise<{issue: number, state: string, route: string|null, requirements: string[], frozen: boolean, tasks: Array<{id: string, title: string, satisfies: string[], command: string|null}>, e2eCoverage: string|null, covered: string[], record: Record_|null}>}
 */
export async function steps(input, { read }) {
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
 * before it could happen, and recorded as a deferral against lib/validation.js.
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
export function ranNothing(run, spec) {
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
 * @param {Records} records
 * @returns {Promise<{ok: boolean, step?: Step, exitCode?: number|null, run?: import('./evidence.js').Capture, error?: string}>}
 */
export async function runSpec(input, { read, save, attach, codify, streak }) {
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
 * @param {Records} records
 * @returns {Promise<{ok: boolean, consecutive?: number, wanted?: number, performed?: number, error?: string, runs?: Array<{path: string, digest: string, exitCode: number|null, durationMs: number}>, last?: import('./evidence.js').Capture}>}
 */
export async function stability(input, { read, codify, recordRun, seriesFreshness }) {
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

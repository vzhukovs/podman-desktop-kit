// SPDX-License-Identifier: Apache-2.0

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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { parsePlan } from './artefacts.js';
import { get, issueDir, resolveHome } from './config.js';
import { capture, digest, writeReceipt } from './evidence.js';
import { parseDuration } from './gate.js';
import { append as appendJournal } from './journal.js';
import { runScript } from './preflight/scope.js';
import { write as writeArtefact } from './render.js';
import { pickScript, scripts as repoScripts } from './repo.js';
import { allocateCounter, read as readState, transition } from './state.js';

/**
 * @typedef {object} Evidence
 * @property {'run'|'artefact'} kind    a captured command, or a file produced while driving the app
 * @property {string} path              relative to the issue directory, or to the repository for artefacts
 * @property {string} digest            sha256 over the transcript, or over the file's bytes
 * @property {number|null} bytes
 */

/**
 * @typedef {object} Step
 * @property {string} id                V1, V2, …
 * @property {string|null} requirement  the R-ID this step demonstrates, when there is one
 * @property {string} title
 * @property {string|null} expected
 * @property {string|null} observed
 * @property {Evidence|null} evidence
 * @property {number|null} exitCode     only for kind: 'run'
 * @property {string} at
 */

/**
 * @typedef {object} Series
 * @property {string|null} spec         path to the codified test, relative to the repository
 * @property {string|null} digest       sha256 of the spec's contents when the runs happened
 * @property {Array<{at: string, exitCode: number|null, evidence: string}>} runs
 * @property {number} consecutive       green runs in a row, counted from the end
 */

/**
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
    return { ...blank(issue), ...parsed, e2e: { ...blank(issue).e2e, ...(parsed.e2e ?? {}) } };
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
  const steps = record?.steps ?? [];
  if (steps.length === 0) return { outcome: 'empty', gaps: [] };

  const statuses = steps.map((step) => statusOf(step));
  const gaps = steps.filter((step) => statusOf(step) === UNVERIFIED);
  const worst = SEVERITY.find((status) => statuses.includes(status)) ?? 'pass';

  return { outcome: worst === 'observed' ? 'pass' : worst, gaps };
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
 * Attach evidence to a validation step, allocating the step if it is new.
 *
 * Note what is not a parameter: the status. `run` produces it through
 * lib/evidence.js, `evidence` produces it by hashing a file that exists. An
 * agent describing what it saw fills `observed`, which is a claim about a real
 * artefact rather than a substitute for one.
 *
 * @param {{issue: number, title: string, requirement?: string|null, expected?: string|null, observed?: string|null, evidence?: string|null, run?: import('./evidence.js').Capture|null, repoRoot?: string, home?: string}} input
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
    let hashed;
    try {
      hashed = await digestFile(input.evidence);
    } catch (error) {
      // Refusing here rather than recording a path is the whole point: a
      // validation record pointing at a file nobody can open is worse than one
      // that admits the step was never demonstrated.
      return { ok: false, error: `${input.evidence}: cannot be read, so it cannot be evidence (${error.code ?? error.message})` };
    }
    evidence = {
      kind: 'artefact',
      path: input.repoRoot && isAbsolute(input.evidence) ? relative(input.repoRoot, resolve(input.evidence)) : input.evidence,
      digest: hashed.digest,
      bytes: hashed.bytes,
    };
  }

  const step = {
    id,
    requirement: input.requirement ?? null,
    title: input.title,
    expected: input.expected ?? null,
    observed: input.observed ?? null,
    evidence,
    exitCode,
    at: new Date().toISOString(),
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

  const spec = relative(input.repoRoot, resolve(file));
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
 * @returns {Promise<{ok: boolean, record?: Record_, evidence?: string, error?: string}>}
 */
export async function recordRun(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  if (!record?.e2e.spec) return { ok: false, error: 'no e2e candidate is registered; run pdkit validate codify first' };

  const path = `validation/e2e-${input.index}.md`;
  await writeReceipt({
    issue: input.issue,
    taskId: `e2e run ${input.index} (${basename(record.e2e.spec)})`,
    path,
    run: input.run,
    home,
  });

  const runs = [...record.e2e.runs, { at: input.run.at, exitCode: input.run.exitCode, evidence: path }];
  let consecutive = 0;
  for (const entry of [...runs].reverse()) {
    if (entry.exitCode !== 0) break;
    consecutive += 1;
  }

  const saved = await save({ ...record, e2e: { ...record.e2e, runs, consecutive } }, { home });
  return { ok: true, record: saved, evidence: path };
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

/** Where CDP announces itself. Upstream's own runner waits on exactly this. */
const READY_PATH = '/json/version';

/** Default port, matching Chromium's conventional one. */
const DEFAULT_PORT = 9222;

/** How long to wait for the window to come up before giving up. */
const DEFAULT_STARTUP_MS = 60_000;

/** How often to ask. Connection errors are expected while the app boots. */
const PROBE_INTERVAL_MS = 500;

/**
 * Which binary to drive, and with what arguments.
 *
 * Three sources, most explicit first. The last one is why `pnpm compile` is not
 * required: `node_modules/.bin/electron .` runs the development build, which is
 * what `pnpm build` produces and what upstream's own e2e uses when
 * PODMAN_DESKTOP_BINARY is unset. Packaging costs minutes and proves nothing
 * extra for validation.
 *
 * @param {{repoRoot: string, config?: object, env?: Record<string, string|undefined>}} input
 * @returns {Promise<{ok: boolean, command?: string, args?: string[], source?: string, error?: string}>}
 */
export async function resolveBinary(input) {
  const env = input.env ?? process.env;

  const configured = String(get(input.config ?? {}, 'validation.app.binary') ?? '').trim();
  if (configured) return { ok: true, command: configured, args: [], source: 'validation.app.binary' };

  const fromEnv = String(env.PODMAN_DESKTOP_BINARY ?? '').trim();
  if (fromEnv) return { ok: true, command: fromEnv, args: [], source: 'PODMAN_DESKTOP_BINARY' };

  const electron = join(input.repoRoot, 'node_modules', '.bin', 'electron');
  try {
    await access(electron, constants.X_OK);
    return { ok: true, command: electron, args: ['.'], source: 'node_modules/.bin/electron' };
  } catch {
    return {
      ok: false,
      error:
        'no application to drive: validation.app.binary is empty, PODMAN_DESKTOP_BINARY is unset, and ' +
        'node_modules/.bin/electron is not in this working tree. Install dependencies and build the ' +
        'application, or point validation.app.binary at a packaged one',
    };
  }
}

/**
 * Ask the CDP endpoint whether it is up.
 *
 * @param {number} port
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>}
 */
async function ready(port, options = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${READY_PATH}`, { signal: options.signal });
    return response.ok;
  } catch {
    // Connection refused is the normal answer for the first several seconds.
    return false;
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function alive(pid) {
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Start the built application with remote debugging on, and wait until CDP
 * answers.
 *
 * The shape is taken from upstream's own runner
 * (tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts): spawn with
 * --remote-debugging-port, poll /json/version, then connect. Which is the whole
 * answer to "can Playwright drive podman-desktop" — the repository has been
 * doing it in CI. pdkit stops at the endpoint: connecting to it is the MCP
 * server's job, and the plugin neither ships nor enables that server.
 *
 * Detached on purpose. The application has to outlive the pdkit process that
 * started it, or the agent would have nothing to drive by the time this
 * command returned.
 *
 * @param {{issue: number, repoRoot: string, port?: number, config?: object, home?: string, timeoutMs?: number, env?: Record<string, string|undefined>}} input
 * @returns {Promise<{ok: boolean, app?: Record_['app'], error?: string, alreadyRunning?: boolean}>}
 */
export async function launch(input) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? {};
  const port = input.port ?? Number(get(config, 'validation.app.debug_port') ?? DEFAULT_PORT);
  const timeoutMs = input.timeoutMs ?? parseDuration(get(config, 'validation.app.startup_timeout')) ?? DEFAULT_STARTUP_MS;

  const record = (await read(input.issue, { home })) ?? blank(input.issue);

  // A previous launch still running is not a failure — it is the thing the
  // caller wanted. Spawning a second copy on the same port would produce an app
  // that starts and immediately fails to bind, which reads as "the build is
  // broken" to everyone who sees it afterwards.
  if (record.app && alive(record.app.pid) && (await ready(record.app.port))) {
    return { ok: true, app: record.app, alreadyRunning: true };
  }

  if (await ready(port)) {
    return {
      ok: false,
      error:
        `something is already answering CDP on port ${port} and it is not this issue's application. ` +
        'Stop it, or set validation.app.debug_port to a free port',
    };
  }

  const binary = await resolveBinary({ repoRoot: input.repoRoot, config, env: input.env });
  if (!binary.ok) return { ok: false, error: binary.error };

  const child = spawn(binary.command, [...binary.args, `--remote-debugging-port=${port}`], {
    cwd: input.repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(input.env ?? {}) },
  });

  const spawned = await new Promise((done) => {
    child.once('spawn', () => done({ ok: true }));
    child.once('error', (error) => done({ ok: false, error: error.message }));
  });
  if (!spawned.ok) return { ok: false, error: `${binary.command}: ${spawned.error}` };

  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready(port)) {
      const app = {
        pid: child.pid,
        port,
        endpoint: `http://127.0.0.1:${port}`,
        binary: binary.command,
        startedAt: new Date().toISOString(),
      };
      await save({ ...record, app }, { home });
      await appendJournal({ issue: input.issue, event: 'app-launched', detail: `pid ${app.pid}, ${app.endpoint}` }, { home });
      return { ok: true, app };
    }

    // The process dying before CDP came up is the more useful failure, and
    // waiting out the full timeout to report it would hide the cause.
    if (!alive(child.pid)) {
      return { ok: false, error: `${binary.command} exited before the CDP endpoint came up (${binary.source})` };
    }

    await wait(PROBE_INTERVAL_MS);
  }

  try {
    process.kill(child.pid);
  } catch {
    // Already gone. Nothing to clean up, and nothing worth reporting over the
    // timeout that brought us here.
  }

  return { ok: false, error: `the CDP endpoint did not answer within ${Math.round(timeoutMs / 1000)}s` };
}

/**
 * Stop the application this issue started.
 *
 * @param {{issue: number, home?: string, timeoutMs?: number}} input
 * @returns {Promise<{ok: boolean, stopped?: boolean, error?: string}>}
 */
export async function stop(input) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });

  if (!record?.app) return { ok: true, stopped: false };

  const { pid } = record.app;
  if (!alive(pid)) {
    await save({ ...record, app: null }, { home });
    return { ok: true, stopped: false };
  }

  try {
    process.kill(pid);
  } catch (error) {
    return { ok: false, error: `could not stop pid ${pid}: ${error.message}` };
  }

  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  while (alive(pid) && Date.now() < deadline) await wait(100);

  await save({ ...record, app: null }, { home });
  await appendJournal({ issue: input.issue, event: 'app-stopped', detail: `pid ${pid}` }, { home });

  return { ok: true, stopped: true };
}

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
    covered: [...new Set((record?.steps ?? []).map((step) => step.requirement).filter(Boolean))],
    record,
  };
}

/**
 * The command that runs the codified test.
 *
 * Resolved from the repository like every other script name (section 7): the
 * e2e entry point of podman-desktop is `test:e2e:run` today, was something else
 * before, and a hardcoded name that stops existing becomes a check that quietly
 * never runs. The spec path is appended, which is how Playwright narrows a run
 * to one file.
 *
 * @param {{repoRoot: string, config?: object, spec: string}} input
 * @returns {Promise<{command: string|null, script?: string, error?: string}>}
 */
export async function specCommand(input) {
  const available = await repoScripts(input.repoRoot);
  const configured = get(input.config ?? {}, 'preflight.scripts.e2e');
  const candidates = Array.isArray(configured) && configured.length > 0 ? configured : ['test:e2e:run', 'test:e2e'];

  const script = pickScript(available, candidates);
  if (!script) {
    return {
      command: null,
      error:
        `no e2e script in this repository (looked for ${candidates.join(', ')}). ` +
        'A validation that ran nothing must not report green',
    };
  }

  return { command: `${runScript({ config: input.config ?? {} }, script)} ${input.spec}`, script };
}

/**
 * Run the codified test once and record it as the evidence for a step.
 *
 * This is what makes PASS mean something here. A screenshot shows what one
 * person saw once; the run is what CI will repeat on every pull request that
 * follows, which is section 8.3's argument for why `Done when` gets stronger
 * when e2e is possible at all.
 *
 * @param {{issue: number, repoRoot: string, spec?: string, requirement?: string|null, config?: object, home?: string, timeoutMs?: number}} input
 * @returns {Promise<{ok: boolean, step?: Step, exitCode?: number|null, output?: string, error?: string}>}
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
    requirement: input.requirement ?? null,
    expected: 'the codified scenario passes',
    run,
  });
  if (!attached.ok) return { ok: false, error: attached.error };

  // The same run counts towards the stability series. Recorded rather than
  // re-run: three runs mean three executions, not three ways of counting one.
  const runs = [...record.e2e.runs, { at: run.at, exitCode: run.exitCode, evidence: attached.step.evidence.path }];
  let consecutive = 0;
  for (const entry of [...runs].reverse()) {
    if (entry.exitCode !== 0) break;
    consecutive += 1;
  }
  const current = await read(input.issue, { home });
  await save({ ...current, e2e: { ...current.e2e, runs, consecutive } }, { home });

  return { ok: true, step: attached.step, exitCode: run.exitCode, output: `${run.stdout}${run.stderr}` };
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
      step.requirement ?? '—',
      step.title,
      step.expected ?? '—',
      step.observed ?? '—',
      evidenceCell(step),
      statusOf(step),
      '',
    ].join(' | ').trim(),
  );

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
 * workflow could deliver (section 8.3), and the only way to tell a flake from a
 * test is to run it more than once. Stops at the first red: a series is not
 * "mostly green", and continuing would spend minutes to reach a conclusion the
 * first failure already gave.
 *
 * Each run gets its own artefact rather than one summary. Three runs are three
 * pieces of evidence, and a summary of them would be exactly the retelling that
 * receipts exist to make impossible.
 *
 * @param {{issue: number, repoRoot: string, runs?: number, config?: object, home?: string, timeoutMs?: number}} input
 * @returns {Promise<{ok: boolean, consecutive?: number, wanted?: number, performed?: number, error?: string, output?: string}>}
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
  let output = '';

  for (let attempt = 1; attempt <= wanted; attempt += 1) {
    const current = await read(input.issue, { home });
    const run = await capture({ command: resolved.command, cwd: input.repoRoot, timeoutMs: input.timeoutMs });
    performed += 1;
    output = `${run.stdout}${run.stderr}`;

    const recorded = await recordRun({ issue: input.issue, home, index: current.e2e.runs.length + 1, run });
    if (!recorded.ok) return { ok: false, error: recorded.error };

    if (run.exitCode !== 0) {
      return {
        ok: false,
        consecutive: recorded.record.e2e.consecutive,
        wanted,
        performed,
        output,
        error: `run ${attempt} of ${wanted} failed (exit ${run.exitCode ?? 'killed'}); a flaky test is not a stable one`,
      };
    }
  }

  const final = await read(input.issue, { home });
  return { ok: final.e2e.consecutive >= wanted, consecutive: final.e2e.consecutive, wanted, performed, output };
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
    lines.push(`  ${status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'observed' ? '📎' : '⚠️'} ${step.id} ${step.title}`);
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

  const root = step.evidence.kind === 'run' ? issueDir(input.home, input.issue) : input.repoRoot;
  const file = join(root, step.evidence.path);

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

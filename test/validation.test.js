// SPDX-License-Identifier: Apache-2.0

// Tests for lib/validation.js.
//
// One thing here is load-bearing and the rest follows from it: the status of a
// step is derived, never handed over. Every test below that looks like
// bookkeeping is really asking the same question — is there any input through
// which "it worked" can be asserted rather than shown.
//
// The second is the series digest. Three green runs against a spec that has
// since been edited is the same stale proof the slice diff digest exists to
// catch, and a test that only ever runs the happy path would not notice it
// missing.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capture } from '../lib/evidence.js';
import { read as readJournal } from '../lib/journal.js';
import * as state from '../lib/state.js';
import { transition } from '../lib/state.js';
import * as validation from '../lib/validation.js';

const ISSUE = 8801;

let home;
let repo;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-validation-'));
  repo = await mkdtemp(join(tmpdir(), 'pdkit-validation-repo-'));
});

beforeEach(async () => {
  await rm(join(home, 'issues'), { recursive: true, force: true });
  await rm(join(home, 'journal'), { recursive: true, force: true });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @param {string} contents
 * @returns {Promise<string>} the path relative to the repository
 */
async function writeSpec(name, contents) {
  await mkdir(join(repo, 'tests/playwright/src/specs'), { recursive: true });
  const relative = `tests/playwright/src/specs/${name}`;
  await writeFile(join(repo, relative), contents);
  return relative;
}

describe('a step without an artefact', () => {
  test('an issue nobody validated reads as nothing, not as an error', async () => {
    assert.equal(await validation.read(ISSUE, { home }), null);
  });

  test('a described step with no artefact is unverified, not passed', async () => {
    const result = await validation.attach({
      issue: ISSUE,
      home,
      title: 'the dialog does not reappear',
      expected: 'no dialog on the second launch',
      observed: 'no dialog',
    });

    assert.equal(result.ok, true);
    assert.equal(validation.statusOf(result.step), 'unverified');
    assert.equal(validation.outcomeOf(await validation.read(ISSUE, { home })).outcome, 'unverified');
  });

  test('an artefact that cannot be read is refused rather than recorded', async () => {
    const result = await validation.attach({
      issue: ISSUE,
      home,
      title: 'contrast',
      evidence: join(repo, 'no-such-screenshot.png'),
      observed: '4.6:1',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /cannot be read/);
    assert.equal(await validation.read(ISSUE, { home }), null);
  });

  test('an artefact with nothing said about it does not count as evidence', async () => {
    const shot = join(repo, 'shot.png');
    await writeFile(shot, 'not really a png');

    const result = await validation.attach({ issue: ISSUE, home, repoRoot: repo, title: 'contrast', evidence: shot });

    assert.equal(result.ok, true);
    assert.equal(result.step.evidence.kind, 'artefact');
    assert.equal(validation.statusOf(result.step), 'unverified');
  });

  test('an artefact plus an observation is evidence, and the path is made repository-relative', async () => {
    const shot = join(repo, 'shot.png');
    await writeFile(shot, 'not really a png');

    const result = await validation.attach({
      issue: ISSUE,
      home,
      repoRoot: repo,
      title: 'contrast',
      evidence: shot,
      observed: 'measured 4.6:1',
    });

    assert.equal(validation.statusOf(result.step), 'observed');
    assert.equal(result.step.evidence.path, 'shot.png');
    assert.match(result.step.evidence.digest, /^sha256:[0-9a-f]{64}$/);
  });
});

describe('a step with a captured run', () => {
  test('a green run passes and its transcript is written where the receipt validator can find it', async () => {
    const run = await capture({ command: 'echo validated' });
    const result = await validation.attach({ issue: ISSUE, home, title: 'the spec passes', run });

    assert.equal(validation.statusOf(result.step), 'pass');
    assert.equal(result.step.evidence.path, 'validation/V1.md');

    const artefact = await readFile(join(home, 'issues', String(ISSUE), 'validation', 'V1.md'), 'utf8');
    assert.match(artefact, /echo validated/);
    assert.match(artefact, /validated/);
  });

  test('a red run is a fail, and the evidence is kept — it is the useful half', async () => {
    const run = await capture({ command: 'echo broken >&2; exit 3' });
    const result = await validation.attach({ issue: ISSUE, home, title: 'the spec passes', run });

    assert.equal(validation.statusOf(result.step), 'fail');
    assert.equal(result.step.exitCode, 3);
    assert.equal(result.step.evidence.kind, 'run');
  });

  test('there is no way to hand a step its status', () => {
    // Not a formality. The whole discipline is that the input does not exist,
    // so a signature that grew one would be a silent regression.
    const source = validation.attach.toString();
    assert.equal(/\bstatus\b/.test(source), false);
  });
});

describe('the outcome of the whole validation', () => {
  test('the worst step wins, and a failure outranks a gap', async () => {
    const green = await capture({ command: 'echo ok' });
    await validation.attach({ issue: ISSUE, home, title: 'first', run: green });
    await validation.attach({ issue: ISSUE, home, title: 'second, undemonstrated' });

    assert.equal(validation.outcomeOf(await validation.read(ISSUE, { home })).outcome, 'unverified');

    const red = await capture({ command: 'exit 1' });
    await validation.attach({ issue: ISSUE, home, title: 'third', run: red });

    assert.equal(validation.outcomeOf(await validation.read(ISSUE, { home })).outcome, 'fail');
  });

  test('observations roll up into pass; only missing artefacts do not', async () => {
    const shot = join(repo, 'rollup.png');
    await writeFile(shot, 'bytes');
    await validation.attach({ issue: ISSUE, home, repoRoot: repo, title: 'looked right', evidence: shot, observed: '4.6:1' });

    const record = await validation.read(ISSUE, { home });
    assert.equal(validation.outcomeOf(record).outcome, 'pass');
    assert.equal(validation.outcomeOf(record).gaps.length, 0);
  });

  test('no steps at all is empty, which is not the same as passing', () => {
    assert.equal(validation.outcomeOf(null).outcome, 'empty');
    assert.equal(validation.outcomeOf({ steps: [] }).outcome, 'empty');
  });

  test('the gaps are named, because that is what has to reach the reviewer', async () => {
    await validation.attach({ issue: ISSUE, home, title: 'needs a real container engine' });
    const { gaps } = validation.outcomeOf(await validation.read(ISSUE, { home }));

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].title, 'needs a real container engine');
  });
});

describe('ids and the journal', () => {
  test('steps are numbered once and do not restart', async () => {
    const first = await validation.attach({ issue: ISSUE, home, title: 'one' });
    const second = await validation.attach({ issue: ISSUE, home, title: 'two' });

    assert.equal(first.step.id, 'V1');
    assert.equal(second.step.id, 'V2');
  });

  test('every attachment is journalled with the status it earned', async () => {
    await validation.attach({ issue: ISSUE, home, title: 'undemonstrated' });
    const entries = await readJournal({ issue: ISSUE }, { home });

    const step = entries.find((entry) => entry.event === 'validation-step');
    assert.ok(step);
    assert.match(step.detail, /V1 unverified/);
  });
});

describe('the e2e candidate', () => {
  test('codifying records the spec and its digest', async () => {
    const spec = await writeSpec('one.spec.ts', 'test("a", () => {});\n');
    const result = await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });

    assert.equal(result.ok, true);
    assert.equal(result.record.e2e.spec, spec);
    assert.match(result.record.e2e.digest, /^sha256:/);
  });

  test('a spec that is not in the repository is refused', async () => {
    const result = await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec: 'tests/playwright/src/specs/absent.spec.ts' });

    assert.equal(result.ok, false);
    assert.match(result.error, /no such file/);
  });

  test('three green runs in a row are counted; a red one in the middle resets the count', async () => {
    const spec = await writeSpec('series.spec.ts', 'test("b", () => {});\n');
    await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });

    for (const index of [1, 2]) {
      await validation.recordRun({ issue: ISSUE, home, index, run: await capture({ command: 'echo pass' }) });
    }
    let record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 2);

    await validation.recordRun({ issue: ISSUE, home, index: 3, run: await capture({ command: 'exit 1' }) });
    record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 0);
    assert.equal(record.e2e.runs.length, 3);

    await validation.recordRun({ issue: ISSUE, home, index: 4, run: await capture({ command: 'echo pass' }) });
    record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 1);
  });

  test('runs cannot be recorded before a candidate exists', async () => {
    const result = await validation.recordRun({ issue: ISSUE, home, index: 1, run: await capture({ command: 'echo pass' }) });

    assert.equal(result.ok, false);
    assert.match(result.error, /codify/);
  });

  test('editing the spec after the runs makes the series stale, and the reason says so', async () => {
    const spec = await writeSpec('stale.spec.ts', 'test("c", () => {});\n');
    await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });
    await validation.recordRun({ issue: ISSUE, home, index: 1, run: await capture({ command: 'echo pass' }) });

    assert.equal((await validation.seriesFreshness({ issue: ISSUE, home, repoRoot: repo })).fresh, true);

    await writeFile(join(repo, spec), 'test("c", () => { expect(1).toBe(2); });\n');
    const stale = await validation.seriesFreshness({ issue: ISSUE, home, repoRoot: repo });

    assert.equal(stale.fresh, false);
    assert.match(stale.reason, /changed after the runs/);
  });

  test('re-codifying a changed spec drops the runs recorded against the old one', async () => {
    const spec = await writeSpec('recodify.spec.ts', 'test("d", () => {});\n');
    await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });
    await validation.recordRun({ issue: ISSUE, home, index: 1, run: await capture({ command: 'echo pass' }) });

    await writeFile(join(repo, spec), 'test("d", () => { /* changed */ });\n');
    const again = await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });

    assert.equal(again.record.e2e.runs.length, 0);
    assert.equal(again.record.e2e.consecutive, 0);
  });
});

describe('rendering', () => {
  test('validation.md carries the derived status and names the gaps', async () => {
    const run = await capture({ command: 'echo ok' });
    await validation.attach({ issue: ISSUE, home, title: 'the spec passes', requirement: 'R1', run });
    await validation.attach({ issue: ISSUE, home, title: 'needs a real container engine' });

    const rendered = await validation.render({ issue: ISSUE, home });
    assert.equal(rendered.ok, true);
    assert.equal(rendered.outcome, 'unverified');

    const document = await readFile(rendered.path, 'utf8');
    assert.match(document, /Outcome: unverified/);
    assert.match(document, /\| R1 \| the spec passes/);
    assert.match(document, /needs a real container engine/);
    // No placeholder survives: render.js throws on one, so this asserts the
    // value map covers the template rather than that the file looks right.
    assert.equal(/\{\{/.test(document), false);
  });

  test('rendering an issue with no record is an answer, not a crash', async () => {
    const result = await validation.render({ issue: 999_999, home });
    assert.equal(result.ok, false);
  });
});

describe('what is waiting to be validated', () => {
  test('the requirements and the plan\'s e2e decision come back together', async () => {
    const issue = 8802;
    await transition(issue, 'triaged', { home });
    await state.allocateRequirement(issue, { home });
    await state.allocateRequirement(issue, { home });

    await mkdir(join(home, 'issues', String(issue)), { recursive: true });
    await writeFile(
      join(home, 'issues', String(issue), 'plan.md'),
      [
        '# PLAN: DESKTOP-8802',
        '',
        '- Requirements: R1, R2',
        '- e2e coverage: required — the dialog is the whole bug',
        '',
        '## Tasks',
        '',
        '### T1: stop the dialog',
        '- Satisfies: R1',
        '- Owns: packages/main/src/dialog.ts',
        '- Done when: `pnpm test:main -- dialog.spec.ts`',
        '',
      ].join('\n'),
    );

    const waiting = await validation.steps({ issue, home });

    assert.deepEqual(waiting.requirements, ['R1', 'R2']);
    assert.match(waiting.e2eCoverage, /^required/);
    assert.equal(waiting.tasks[0].command, 'pnpm test:main -- dialog.spec.ts');
    assert.deepEqual(waiting.covered, []);
  });

  test('a quickfix with no plan is answered, not refused — tracing goes by issue number there', async () => {
    const issue = 8803;
    await transition(issue, 'triaged', { home });

    const waiting = await validation.steps({ issue, home });

    assert.equal(waiting.e2eCoverage, null);
    assert.deepEqual(waiting.tasks, []);
  });
});

describe('running the codified test', () => {
  test('the e2e script is resolved from the repository, never hardcoded', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'playwright test' } }));

    const resolved = await validation.specCommand({ repoRoot: repo, config: {}, spec: 'tests/a.spec.ts' });

    assert.equal(resolved.script, 'test:e2e:run');
    assert.equal(resolved.command, 'pnpm run test:e2e:run tests/a.spec.ts');
  });

  test('a repository with no e2e script refuses rather than reporting green on nothing', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));

    const resolved = await validation.specCommand({ repoRoot: repo, config: {}, spec: 'tests/a.spec.ts' });

    assert.equal(resolved.command, null);
    assert.match(resolved.error, /must not report green/);
  });

  test('the run becomes the step\'s evidence and counts towards the series at once', async () => {
    const spec = await writeSpec('run.spec.ts', 'test("e", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'true' } }));

    const result = await validation.runSpec({ issue: ISSUE, home, repoRoot: repo, spec, requirement: 'R1' });

    assert.equal(result.ok, true, result.error);
    assert.equal(validation.statusOf(result.step), 'pass');
    assert.equal(result.step.requirement, 'R1');

    const record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 1);
    // One execution, one artefact, counted once in both places.
    assert.equal(record.e2e.runs[0].evidence, result.step.evidence.path);
  });

  test('a failing spec produces a failed step rather than an absent one', async () => {
    const spec = await writeSpec('red.spec.ts', 'test("f", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'false' } }));

    const result = await validation.runSpec({ issue: ISSUE, home, repoRoot: repo, spec });

    assert.equal(result.ok, true);
    assert.equal(validation.statusOf(result.step), 'fail');
    assert.equal((await validation.read(ISSUE, { home })).e2e.consecutive, 0);
  });
});

describe('finishing', () => {
  test('a passing validation moves the issue and writes the document', async () => {
    const issue = 8804;
    await transition(issue, 'triaged', { home });
    await transition(issue, 'planned', { home });
    await transition(issue, 'plan-approved', { home });
    await transition(issue, 'implemented', { home });

    await validation.attach({ issue, home, title: 'the spec passes', run: await capture({ command: 'echo ok' }) });
    const result = await validation.finish({ issue, home });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'pass');
    assert.equal(result.moved, true);
    assert.equal((await state.read(issue, { home })).state, 'validated');
  });

  test('unverified still moves the issue — the gap is carried, not used as a wall', async () => {
    const issue = 8805;
    await transition(issue, 'triaged', { home });
    await transition(issue, 'planned', { home });
    await transition(issue, 'plan-approved', { home });
    await transition(issue, 'implemented', { home });

    await validation.attach({ issue, home, title: 'needs a real container engine' });
    const result = await validation.finish({ issue, home });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'unverified');
    assert.equal(result.moved, true);
    assert.equal(result.gaps.length, 1);
    assert.equal((await state.read(issue, { home })).state, 'validated');
  });

  test('a failed step does not move the issue', async () => {
    const issue = 8806;
    await transition(issue, 'triaged', { home });
    await transition(issue, 'planned', { home });
    await transition(issue, 'plan-approved', { home });
    await transition(issue, 'implemented', { home });

    await validation.attach({ issue, home, title: 'the spec passes', run: await capture({ command: 'exit 2' }) });
    const result = await validation.finish({ issue, home });

    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'fail');
    assert.equal((await state.read(issue, { home })).state, 'implemented');
    assert.ok(result.path, 'the document is written anyway: the red run is the useful half');
  });

  test('finishing with nothing recorded is refused', async () => {
    const result = await validation.finish({ issue: 999_997, home });

    assert.equal(result.ok, false);
    assert.match(result.error, /nothing validated/);
  });
});

describe('launching the application under CDP', () => {
  // A real process, spawned the way the real one is, answering on /json/version
  // the way Electron does. Only the application is a stand-in — everything the
  // code under test does (detached spawn, polling, killing) is the real thing,
  // and a mocked spawn would only confirm what the mock believes.

  /** @type {string[]} */
  let stubs;

  /**
   * @param {string} name
   * @param {string} body   the script, minus the shebang
   * @returns {Promise<string>}
   */
  async function stub(name, body) {
    const path = join(repo, name);
    await writeFile(path, `#!/usr/bin/env node\n${body}`);
    await chmod(path, 0o755);
    stubs.push(path);
    return path;
  }

  /** A free port, found by letting the OS pick one and handing it back. */
  async function freePort() {
    const server = createServer();
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    await new Promise((done) => server.close(done));
    return port;
  }

  const APP = `
const { createServer } = require('node:http');
const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
const delay = Number(process.env.STUB_DELAY_MS ?? 0);
setTimeout(() => {
  createServer((req, res) => {
    if (req.url === '/json/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"Browser":"stub"}'); }
    else { res.writeHead(404); res.end(); }
  }).listen(port, '127.0.0.1');
}, delay);
`;

  before(() => {
    stubs = [];
  });

  beforeEach(async () => {
    await validation.stop({ issue: ISSUE, home });
  });

  after(async () => {
    await validation.stop({ issue: ISSUE, home });
  });

  test('the binary is resolved from config, then the environment, then the working tree', async () => {
    const configured = await validation.resolveBinary({
      repoRoot: repo,
      config: { validation: { app: { binary: '/opt/podman-desktop' } } },
      env: { PODMAN_DESKTOP_BINARY: '/from/env' },
    });
    assert.equal(configured.command, '/opt/podman-desktop');

    const fromEnv = await validation.resolveBinary({ repoRoot: repo, config: {}, env: { PODMAN_DESKTOP_BINARY: '/from/env' } });
    assert.equal(fromEnv.command, '/from/env');
    assert.deepEqual(fromEnv.args, []);
  });

  test('a working tree with electron installed needs no packaged binary', async () => {
    await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
    const electron = join(repo, 'node_modules', '.bin', 'electron');
    await writeFile(electron, '#!/bin/sh\nexit 0\n');
    await chmod(electron, 0o755);

    const resolved = await validation.resolveBinary({ repoRoot: repo, config: {}, env: {} });

    assert.equal(resolved.command, electron);
    assert.deepEqual(resolved.args, ['.'], 'the development build is run as `electron .`, which is what pnpm build produces');

    await rm(join(repo, 'node_modules'), { recursive: true, force: true });
  });

  test('nothing to drive is an explanation, not a stack trace', async () => {
    const resolved = await validation.resolveBinary({ repoRoot: repo, config: {}, env: {} });

    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /PODMAN_DESKTOP_BINARY/);
  });

  test('a launched application is recorded with its endpoint, and answers there', async () => {
    const binary = await stub('app.js', APP);
    const port = await freePort();

    const result = await validation.launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app: { binary } } },
      timeoutMs: 20_000,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.app.port, port);
    assert.equal(result.app.endpoint, `http://127.0.0.1:${port}`);
    assert.equal(validation.alive(result.app.pid), true);

    const response = await fetch(`${result.app.endpoint}/json/version`);
    assert.equal(response.ok, true);

    const record = await validation.read(ISSUE, { home });
    assert.equal(record.app.pid, result.app.pid);
  });

  test('launching twice does not start a second copy on the same port', async () => {
    const binary = await stub('app-twice.js', APP);
    const port = await freePort();
    const input = { issue: ISSUE, home, repoRoot: repo, port, config: { validation: { app: { binary } } }, timeoutMs: 20_000 };

    const first = await validation.launch(input);
    const second = await validation.launch(input);

    assert.equal(second.ok, true, second.error);
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.app.pid, first.app.pid);
  });

  test('a port someone else is holding is refused rather than fought over', async () => {
    const binary = await stub('app-busy.js', APP);
    const server = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"Browser":"someone else"}');
    });
    const port = await freePort();
    await new Promise((done) => server.listen(port, '127.0.0.1', done));

    try {
      const result = await validation.launch({
        issue: ISSUE,
        home,
        repoRoot: repo,
        port,
        config: { validation: { app: { binary } } },
        timeoutMs: 5000,
      });

      assert.equal(result.ok, false);
      assert.match(result.error, /already answering CDP/);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test('an application that dies before CDP comes up says so, without waiting out the timeout', async () => {
    const binary = await stub('app-dies.js', 'process.exit(7);\n');
    const port = await freePort();

    const started = Date.now();
    const result = await validation.launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app: { binary } } },
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /exited before the CDP endpoint came up/);
    assert.ok(Date.now() - started < 10_000, 'the death is the finding; waiting out 30s to report it would hide the cause');
  });

  test('an application that never answers is killed rather than left running', async () => {
    const binary = await stub('app-silent.js', 'setInterval(() => {}, 1000);\n');
    const port = await freePort();

    const result = await validation.launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app: { binary } } },
      timeoutMs: 1500,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /did not answer within/);
    assert.equal((await validation.read(ISSUE, { home }))?.app ?? null, null, 'a failed launch records no running app');
  });

  test('stopping kills the process and clears the record', async () => {
    const binary = await stub('app-stop.js', APP);
    const port = await freePort();

    const launched = await validation.launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app: { binary } } },
      timeoutMs: 20_000,
    });
    assert.equal(launched.ok, true, launched.error);

    const stopped = await validation.stop({ issue: ISSUE, home });

    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(validation.alive(launched.app.pid), false);
    assert.equal((await validation.read(ISSUE, { home })).app, null);
  });

  test('stopping what was never started is fine', async () => {
    const result = await validation.stop({ issue: 999_998, home });

    assert.equal(result.ok, true);
    assert.equal(result.stopped, false);
  });
});

describe('evidence that moved after it was attached', () => {
  test('a changed screenshot stops being intact', async () => {
    const shot = join(repo, 'moved.png');
    await writeFile(shot, 'first');
    const attached = await validation.attach({
      issue: ISSUE,
      home,
      repoRoot: repo,
      title: 'contrast',
      evidence: shot,
      observed: '4.6:1',
    });

    assert.equal((await validation.evidenceIntact({ repoRoot: repo, home, issue: ISSUE, step: attached.step })).ok, true);

    await writeFile(shot, 'second');
    const after = await validation.evidenceIntact({ repoRoot: repo, home, issue: ISSUE, step: attached.step });

    assert.equal(after.ok, false);
    assert.match(after.reason, /changed after it was attached/);
  });

  test('a deleted artefact is reported as gone rather than as intact', async () => {
    const shot = join(repo, 'deleted.png');
    await writeFile(shot, 'bytes');
    const attached = await validation.attach({
      issue: ISSUE,
      home,
      repoRoot: repo,
      title: 'contrast',
      evidence: shot,
      observed: '4.6:1',
    });

    await rm(shot);
    const after = await validation.evidenceIntact({ repoRoot: repo, home, issue: ISSUE, step: attached.step });

    assert.equal(after.ok, false);
    assert.match(after.reason, /gone/);
  });
});

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

import { emits, exits } from './helpers/commands.js';
import { capture } from '../lib/evidence.js';
import { read as readJournal } from '../lib/journal.js';
import * as state from '../lib/state.js';
import { transition } from '../lib/state.js';
import * as validation from '../lib/validation.js';

const ISSUE = 8801;

/**
 * npm rather than pnpm, for the reason slice.test.js gives: the fixture's
 * scripts are plain node and the run has to actually happen.
 *
 * Passed explicitly, and that is the whole point. Without a config
 * `specCommand` falls back to `repo.package_manager ?? 'pnpm'`, so these tests
 * shelled out to pnpm and passed only on a machine that happened to have it.
 * The first CI run this repository ever had failed here on ubuntu and macOS
 * with `exit 127` — command not found — while the suite had been green locally
 * for a month. A dependency nothing declares is one the developer's laptop is
 * quietly satisfying.
 */
const CONFIG = { repo: { package_manager: 'npm' } };

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

  // The artefact is copied in beside the record rather than referenced where it
  // lies. A screenshot taken into a temporary directory is gone by the next
  // reboot, and one taken outside the repository produced a path of five `..`
  // segments describing it as part of the fork.
  test('an artefact plus an observation is evidence, and the file is kept with the record', async () => {
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
    assert.equal(result.step.evidence.path, 'validation/artefacts/V1.png');
    assert.equal(result.step.evidence.from, shot);
    assert.match(result.step.evidence.digest, /^sha256:[0-9a-f]{64}$/);

    const kept = await readFile(join(home, 'issues', String(ISSUE), 'validation', 'artefacts', 'V1.png'), 'utf8');
    assert.equal(kept, 'not really a png');
  });

  test('an artefact outside the repository is kept too, without a path of dot-dots', async () => {
    const elsewhere = join(tmpdir(), `pdkit-outside-${process.pid}.json`);
    await writeFile(elsewhere, '{"targets":1}');

    const result = await validation.attach({
      issue: ISSUE,
      home,
      repoRoot: repo,
      title: 'the window is up',
      evidence: elsewhere,
      observed: 'one page target',
    });

    assert.equal(result.step.evidence.path, 'validation/artefacts/V1.json');
    assert.equal(result.step.evidence.path.includes('..'), false);

    await rm(elsewhere, { force: true });
    // Deleting the source does not touch the evidence: that is the point of
    // keeping a copy.
    assert.equal((await validation.evidenceIntact({ repoRoot: repo, home, issue: ISSUE, step: result.step })).ok, true);
  });
});

describe('a step with a captured run', () => {
  test('a green run passes and its transcript is written where the receipt validator can find it', async () => {
    const command = emits('validated\n');
    const run = await capture({ command });
    const result = await validation.attach({ issue: ISSUE, home, title: 'the spec passes', run });

    assert.equal(validation.statusOf(result.step), 'pass');
    assert.equal(result.step.evidence.path, 'validation/V1.md');

    const artefact = await readFile(join(home, 'issues', String(ISSUE), 'validation', 'V1.md'), 'utf8');
    // The command it names and the output it produced: a transcript missing
    // either is not evidence that this ran.
    assert.ok(artefact.includes(command));
    assert.match(artefact, /validated/);
  });

  test('a red run is a fail, and the evidence is kept — it is the useful half', async () => {
    const run = await capture({ command: exits(3, { err: 'broken\n' }) });
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
    const green = await capture({ command: emits('ok\n') });
    await validation.attach({ issue: ISSUE, home, title: 'first', run: green });
    await validation.attach({ issue: ISSUE, home, title: 'second, undemonstrated' });

    assert.equal(validation.outcomeOf(await validation.read(ISSUE, { home })).outcome, 'unverified');

    const red = await capture({ command: exits(1) });
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
      await validation.recordRun({ issue: ISSUE, home, index, run: await capture({ command: emits('pass\n') }) });
    }
    let record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 2);

    await validation.recordRun({ issue: ISSUE, home, index: 3, run: await capture({ command: exits(1) }) });
    record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 0);
    assert.equal(record.e2e.runs.length, 3);

    await validation.recordRun({ issue: ISSUE, home, index: 4, run: await capture({ command: emits('pass\n') }) });
    record = await validation.read(ISSUE, { home });
    assert.equal(record.e2e.consecutive, 1);
  });

  test('runs cannot be recorded before a candidate exists', async () => {
    const result = await validation.recordRun({ issue: ISSUE, home, index: 1, run: await capture({ command: emits('pass\n') }) });

    assert.equal(result.ok, false);
    assert.match(result.error, /codify/);
  });

  test('editing the spec after the runs makes the series stale, and the reason says so', async () => {
    const spec = await writeSpec('stale.spec.ts', 'test("c", () => {});\n');
    await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });
    await validation.recordRun({ issue: ISSUE, home, index: 1, run: await capture({ command: emits('pass\n') }) });

    assert.equal((await validation.seriesFreshness({ issue: ISSUE, home, repoRoot: repo })).fresh, true);

    await writeFile(join(repo, spec), 'test("c", () => { expect(1).toBe(2); });\n');
    const stale = await validation.seriesFreshness({ issue: ISSUE, home, repoRoot: repo });

    assert.equal(stale.fresh, false);
    assert.match(stale.reason, /changed after the runs/);
  });

  test('re-codifying a changed spec drops the runs recorded against the old one', async () => {
    const spec = await writeSpec('recodify.spec.ts', 'test("d", () => {});\n');
    await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });
    await validation.recordRun({ issue: ISSUE, home, index: 1, run: await capture({ command: emits('pass\n') }) });

    await writeFile(join(repo, spec), 'test("d", () => { /* changed */ });\n');
    const again = await validation.codify({ issue: ISSUE, home, repoRoot: repo, spec });

    assert.equal(again.record.e2e.runs.length, 0);
    assert.equal(again.record.e2e.consecutive, 0);
  });
});

describe('rendering', () => {
  test('validation.md carries the derived status and names the gaps', async () => {
    const run = await capture({ command: emits('ok\n') });
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

  // podman-desktop's `test:e2e:run` already ends in a path. Appending our spec
  // gave Playwright two positional filters, so all forty-four specs ran and
  // were reported as this one — found when a three-second spec was still going
  // after ten minutes.
  test('a script that carries its own path is refused, not widened', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({
        scripts: { 'test:e2e:run': "xvfb-maybe -- npx playwright test tests/playwright/src/specs/ --grep-invert @k8s" },
      }),
    );

    const resolved = await validation.specCommand({ repoRoot: repo, config: {}, spec: 'tests/a.spec.ts' });

    assert.equal(resolved.command, null);
    assert.match(resolved.error, /widens the run instead of narrowing it/);
    assert.match(resolved.error, /preflight\.scripts\.e2e_spec/);
  });

  test('a repository that drives Playwright gets the runner, and only the spec', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'echo suite' } }));
    await writeFile(join(repo, 'playwright.config.ts'), 'export default {};\n');

    try {
      const resolved = await validation.specCommand({ repoRoot: repo, config: {}, spec: 'tests/a.spec.ts' });

      assert.equal(resolved.command, 'pnpm exec playwright test tests/a.spec.ts');
      assert.equal(resolved.runner, 'playwright');
    } finally {
      await rm(join(repo, 'playwright.config.ts'), { force: true });
    }
  });

  test('a configured single-spec command wins over anything inferred', async () => {
    const resolved = await validation.specCommand({
      repoRoot: repo,
      config: { preflight: { scripts: { e2e_spec: 'make e2e SPEC={spec}' } } },
      spec: 'tests/a.spec.ts',
    });

    assert.equal(resolved.command, 'make e2e SPEC=tests/a.spec.ts');
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

    const result = await validation.runSpec({ issue: ISSUE, home, repoRoot: repo, spec, requirement: 'R1', config: CONFIG });

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

    const result = await validation.runSpec({ issue: ISSUE, home, repoRoot: repo, spec, config: CONFIG });

    assert.equal(result.ok, true);
    assert.equal(validation.statusOf(result.step), 'fail');
    assert.equal((await validation.read(ISSUE, { home })).e2e.consecutive, 0);
  });
});

describe('stability', () => {
  test('three green runs in a row make a series, with three artefacts and not one summary', async () => {
    const issue = 8807;
    const spec = await writeSpec('stable.spec.ts', 'test("g", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'true' } }));
    await validation.codify({ issue, home, repoRoot: repo, spec });

    const result = await validation.stability({ issue, home, repoRoot: repo, runs: 3, config: CONFIG });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.consecutive, 3);
    assert.equal(result.performed, 3);

    for (const index of [1, 2, 3]) {
      const artefact = await readFile(join(home, 'issues', String(issue), 'validation', `e2e-${index}.md`), 'utf8');
      assert.match(artefact, /## Output/);
    }
  });

  test('the first red run ends the series instead of spending minutes to confirm it', async () => {
    const issue = 8808;
    const spec = await writeSpec('flaky.spec.ts', 'test("h", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'false' } }));
    await validation.codify({ issue, home, repoRoot: repo, spec });

    const result = await validation.stability({ issue, home, repoRoot: repo, runs: 3, config: CONFIG });

    assert.equal(result.ok, false);
    assert.equal(result.performed, 1);
    assert.equal(result.consecutive, 0);
    assert.match(result.error, /flaky test is not a stable one/);
  });

  test('a series cannot be run before a candidate exists', async () => {
    const result = await validation.stability({ issue: 999_996, home, repoRoot: repo, runs: 3, config: CONFIG });

    assert.equal(result.ok, false);
    assert.match(result.error, /codify/);
  });

  test('a spec edited since the last series is re-digested, so the runs describe what is on disk', async () => {
    const issue = 8809;
    const spec = await writeSpec('edited.spec.ts', 'test("i", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'true' } }));
    await validation.codify({ issue, home, repoRoot: repo, spec });
    await validation.stability({ issue, home, repoRoot: repo, runs: 1, config: CONFIG });

    await writeFile(join(repo, spec), 'test("i", () => { /* now different */ });\n');
    const again = await validation.stability({ issue, home, repoRoot: repo, runs: 2, config: CONFIG });

    assert.equal(again.ok, true, again.error);
    assert.equal(again.consecutive, 2, 'the run recorded against the old contents does not count towards the new series');
    assert.equal((await validation.seriesFreshness({ issue, home, repoRoot: repo })).fresh, true);
  });

  test('a spec deleted since it was codified is refused', async () => {
    const issue = 8810;
    const spec = await writeSpec('vanishing.spec.ts', 'test("j", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'true' } }));
    await validation.codify({ issue, home, repoRoot: repo, spec });
    await rm(join(repo, spec));

    const result = await validation.stability({ issue, home, repoRoot: repo, runs: 3, config: CONFIG });

    assert.equal(result.ok, false);
    assert.match(result.error, /no longer in the repository/);
  });

  // The failure this check exists to stop, which an exit code cannot see. Every
  // machine spec in this repository opens with
  // `test.skip(process.env.TEST_PODMAN_MACHINE !== 'true')`; run without it the
  // suite skips its whole body and exits 0, and three of those satisfied the
  // blocking e2e-stability gate on evidence of nothing.
  test('a run that skipped everything is not a green run', async () => {
    const issue = 8811;
    const spec = await writeSpec('gated.spec.ts', 'test.skip("k", () => {});\n');
    await writeFile(
      join(repo, 'package.json'),
      // The count is computed rather than written, so the summary this asserts
      // on can only have come from the run — npm echoes the script line, and a
      // literal "15 skipped" there would be matched as well as produced.
      JSON.stringify({ scripts: { 'test:e2e:run': 'node -e "console.log((5*3)+String.fromCharCode(32)+\'skipped\')"' } }),
    );
    await validation.codify({ issue, home, repoRoot: repo, spec });

    const result = await validation.stability({ issue, home, repoRoot: repo, runs: 3, config: CONFIG });

    assert.equal(result.ok, false);
    assert.equal(result.performed, 1, 'the series stops on the first one rather than repeating an empty suite');
    assert.equal(result.consecutive, 0);
    assert.match(result.error, /no test executed \(15 skipped\)/);
    assert.match(result.error, /gated on something this environment does not satisfy/);

    // The run still happened and its capture is on disk. What it is not is a pass.
    const artefact = await readFile(join(home, 'issues', String(issue), 'validation', 'e2e-1.md'), 'utf8');
    assert.match(artefact, /## Output/);
  });

  test('a run whose reporter says nothing recognisable is left alone', async () => {
    const issue = 8812;
    const spec = await writeSpec('quiet.spec.ts', 'test("l", () => {});\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:e2e:run': 'true' } }));
    await validation.codify({ issue, home, repoRoot: repo, spec });

    const result = await validation.stability({ issue, home, repoRoot: repo, runs: 2, config: CONFIG });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.consecutive, 2, 'no summary means no claim, not a refusal');
  });
});

describe('outcomes', () => {
  test('reads what a run reported, and separates executed from skipped', () => {
    assert.deepEqual(validation.outcomes('\n  12 passed (3.1m)\n'), { executed: 12, skipped: 0 });
    assert.deepEqual(validation.outcomes('\n  15 skipped\n'), { executed: 0, skipped: 15 });
    assert.deepEqual(validation.outcomes('  2 flaky\n  1 skipped\n  9 passed (1m)\n'), { executed: 11, skipped: 1 });
  });

  test('output with no summary at all is null, not zero', () => {
    assert.equal(validation.outcomes(''), null);
    assert.equal(validation.outcomes('Everything is fine.'), null);
  });
});

describe('finishing', () => {
  test('a passing validation moves the issue and writes the document', async () => {
    const issue = 8804;
    await transition(issue, 'triaged', { home });
    await transition(issue, 'planned', { home });
    await transition(issue, 'plan-approved', { home });
    await transition(issue, 'implemented', { home });

    await validation.attach({ issue, home, title: 'the spec passes', run: await capture({ command: emits('ok\n') }) });
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

    await validation.attach({ issue, home, title: 'the spec passes', run: await capture({ command: exits(2) }) });
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

/**
 * Whether `launch` would refuse before spawning anything.
 *
 * The same question `displayProblem` answers, asked of this process rather than
 * of a hypothetical one — and asked because these seven tests cannot run where
 * the answer is yes. A headless Linux runner has neither DISPLAY nor
 * WAYLAND_DISPLAY, so the application would start and exit before CDP came up,
 * which is exactly what the library refuses to pretend it can do.
 *
 * Skipped rather than adapted: the refusal itself is covered by
 * `displayProblem`'s own test below, and the thing these seven exist to
 * exercise — a real detached spawn, polled and then killed — has no meaning
 * without something to spawn into. `xvfb-run -a npm test` runs them on Linux.
 */
const headless = validation.displayProblem(process.env, process.platform) !== null;

describe('launching the application under CDP', { skip: headless ? 'no display: run under xvfb-run to exercise these' : false }, () => {
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
  // A plain script run by this process's own node, rather than an executable
  // with a shebang. Windows has neither shebangs nor an execute bit, so the
  // old stub spawned as `EFTYPE` and took all seven of these tests with it —
  // and the obvious repair, a `.cmd` shim, would put cmd.exe between the test
  // and the process it then asserts `stop` kills.
  //
  // What it returns is what `validation.app.binary` and `.app.args` take, so
  // the launch path under test is the real one on every platform.
  async function stub(name, body) {
    const path = join(repo, name);
    await writeFile(path, body);
    stubs.push(path);
    return { binary: process.execPath, args: [path] };
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

  /** Every application this block started, so none outlives the run. */
  /** @type {number[]} */
  let spawned;

  /**
   * launch(), remembering the pid.
   *
   * `validation.stop` can only stop what the record holds, and the record holds
   * one application — the last one. Tests that launch on different ports left
   * every earlier process running: 240 of them were still alive before anyone
   * looked, holding ports and filling the process table.
   *
   * @param {object} input
   */
  async function launch(input) {
    const result = await validation.launch(input);
    if (result.app?.pid) spawned.push(result.app.pid);
    return result;
  }

  before(() => {
    stubs = [];
    spawned = [];
  });

  beforeEach(async () => {
    await validation.stop({ issue: ISSUE, home });
  });

  after(async () => {
    await validation.stop({ issue: ISSUE, home });
    for (const pid of spawned) {
      try {
        process.kill(pid);
      } catch {
        // Already gone, which is the usual case and the desired one.
      }
    }
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
    const app = await stub('app.js', APP);
    const port = await freePort();

    const result = await launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app } },
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
    const app = await stub('app-twice.js', APP);
    const port = await freePort();
    const input = { issue: ISSUE, home, repoRoot: repo, port, config: { validation: { app } }, timeoutMs: 20_000 };

    const first = await launch(input);
    const second = await launch(input);

    assert.equal(second.ok, true, second.error);
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.app.pid, first.app.pid);
  });

  test('a port someone else is holding is refused rather than fought over', async () => {
    const app = await stub('app-busy.js', APP);
    const server = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"Browser":"someone else"}');
    });
    const port = await freePort();
    await new Promise((done) => server.listen(port, '127.0.0.1', done));

    try {
      const result = await launch({
        issue: ISSUE,
        home,
        repoRoot: repo,
        port,
        config: { validation: { app } },
        timeoutMs: 5000,
      });

      assert.equal(result.ok, false);
      assert.match(result.error, /already answering CDP/);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test('an application that dies before CDP comes up says so, without waiting out the timeout', async () => {
    const app = await stub('app-dies.js', 'process.exit(7);\n');
    const port = await freePort();

    const started = Date.now();
    const result = await launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app } },
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /exited before the CDP endpoint came up/);
    assert.ok(Date.now() - started < 10_000, 'the death is the finding; waiting out 30s to report it would hide the cause');
  });

  test('an application that never answers is killed rather than left running', async () => {
    const app = await stub('app-silent.js', 'setInterval(() => {}, 1000);\n');
    const port = await freePort();

    const result = await launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app } },
      timeoutMs: 1500,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /did not answer within/);
    assert.equal((await validation.read(ISSUE, { home }))?.app ?? null, null, 'a failed launch records no running app');
  });

  test('stopping kills the process and clears the record', async () => {
    const app = await stub('app-stop.js', APP);
    const port = await freePort();

    const launched = await launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app } },
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
    const result = await validation.stop({ issue: 999_998, home, port: await freePort() });

    assert.equal(result.ok, true);
    assert.equal(result.stopped, false);
  });

  // Observed on the first live run, and the report was wrong in the direction
  // that matters: the record had been removed while the application was still
  // up, and `stop` said "nothing was running" about a live Electron process
  // holding the debug port.
  test('a lost record does not turn a running application into "nothing was running"', async () => {
    const app = await stub('app-orphan.js', APP);
    const port = await freePort();

    const launched = await launch({
      issue: ISSUE,
      home,
      repoRoot: repo,
      port,
      config: { validation: { app } },
      timeoutMs: 20_000,
    });
    assert.equal(launched.ok, true, launched.error);

    await rm(join(home, 'issues', String(ISSUE)), { recursive: true, force: true });
    const result = await validation.stop({ issue: ISSUE, home, port });

    assert.equal(result.ok, false);
    assert.match(result.error, /still answering CDP/);

    process.kill(launched.app.pid);
  });

  // Found by leaving one behind. An application that holds the port and answers
  // nothing is not the same as a free port, and until 0.22 the difference cost
  // a full startup_timeout of silence and a message blaming the build.
  test('a port held by something that never answers is refused, and quickly', async () => {
    const port = await freePort();
    const wedged = createServer(() => {
      // Accept, and never reply. This is what a dying Electron does.
    });
    await new Promise((done) => wedged.listen(port, '127.0.0.1', done));

    try {
      const started = Date.now();
      const result = await launch({
        issue: ISSUE,
        home,
        repoRoot: repo,
        port,
        config: { validation: { app: await stub('never-used.js', APP) } },
        timeoutMs: 60_000,
      });

      assert.equal(result.ok, false);
      assert.match(result.error, new RegExp(`holds port ${port} without answering`));
      assert.match(result.error, /lsof/);
      // The point of the whole change: it must not wait out the launch budget.
      assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
    } finally {
      await new Promise((done) => wedged.close(done));
    }
  });

  // The relaunch caveat, which is only worth printing the second time round.
  test('a second launch is marked as a relaunch, and the first is not', async () => {
    const app = await stub('relaunch.js', APP);
    const port = await freePort();
    const input = { issue: ISSUE, home, repoRoot: repo, port, config: { validation: { app } }, timeoutMs: 20_000 };

    const first = await launch(input);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.relaunch, false, 'nothing can be holding a window that never existed');

    await validation.stop({ issue: ISSUE, home, port });

    const second = await launch(input);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.relaunch, true, 'survives stop, which clears app but not the count');

    await validation.stop({ issue: ISSUE, home, port });
  });

  // Linux is the only platform this can be answered on, and only in one
  // direction. Refusing on macOS or Windows because no variable proves a
  // desktop would break the platform that works to guess about the others.
  test('a Linux session with no display is named, and the other platforms are left alone', () => {
    assert.match(validation.displayProblem({}, 'linux'), /DISPLAY/);
    assert.match(validation.displayProblem({}, 'linux'), /xvfb-run/);
    assert.equal(validation.displayProblem({ DISPLAY: ':0' }, 'linux'), null);
    assert.equal(validation.displayProblem({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), null);
    assert.equal(validation.displayProblem({}, 'darwin'), null);
    assert.equal(validation.displayProblem({}, 'win32'), null);
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

    // The kept copy, not the source — editing the original proves nothing, and
    // this is what an auditor would open.
    await writeFile(join(home, 'issues', String(ISSUE), 'validation', 'artefacts', 'V1.png'), 'second');
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

    await rm(join(home, 'issues', String(ISSUE), 'validation', 'artefacts', 'V1.png'));
    const after = await validation.evidenceIntact({ repoRoot: repo, home, issue: ISSUE, step: attached.step });

    assert.equal(after.ok, false);
    assert.match(after.reason, /gone/);
  });
});

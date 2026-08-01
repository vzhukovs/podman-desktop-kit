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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capture } from '../lib/evidence.js';
import { read as readJournal } from '../lib/journal.js';
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

// SPDX-License-Identifier: Apache-2.0

// Tests for lib/knowledge.js.
//
// The finding this module exists for is drift that nobody notices: the layer
// chain in package-map.md fell behind slicing.layer_order when stage 3 added
// three packages to the merge order, and it stayed behind for a whole stage
// because the only thing that could have caught it was someone re-reading a
// file they had no reason to doubt.
//
// So the tests are about the three ways prose goes stale — a path that moved,
// a list that drifted, an entry that stopped following its own file's shape —
// and about the boundary: this module reports, and never edits knowledge/.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, initRepo, seedWorkspace, writeFiles } from './helpers/repo-fixture.js';
import * as knowledge from '../lib/knowledge.js';

let dir;
let repo;
let home;

const CONFIG = { slicing: { layer_order: ['extension-api', 'main', 'ui', 'tests'] } };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdkit-knowledge-'));
  home = await mkdtemp(join(tmpdir(), 'pdkit-knowledge-home-'));
  repo = await initRepo('pdkit-knowledge-repo-');
  await seedWorkspace(repo);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await cleanup(repo);
});

/**
 * @param {Record<string, string>} entries
 */
async function base(entries) {
  await rm(dir, { recursive: true, force: true });
  // No mkdtemp here. There used to be one, and its result was never assigned:
  // every call created a temp directory, dropped the handle, and then wrote to
  // the path it had just deleted — which works only because writeFiles mkdirs.
  // One orphan per test, and the suite runs this per test: 1313 of them had
  // accumulated in /var/folders before anyone counted.
  await writeFiles(dir, entries);
}

/** @param {object} [overrides] */
const collect = (overrides = {}) => knowledge.collect({ dir, repoRoot: repo, config: CONFIG, home, ...overrides });

describe('references that stopped being true', () => {
  test('a path that is no longer in the fork is reported', async () => {
    await base({
      'notes.md': [
        '# Notes',
        '',
        'The exec helper lives in `packages/main/src/exec.ts`, and the old one was',
        'at `packages/main/src/legacy/exec.ts`.',
        '',
        '## What to add here',
        '- things',
        '',
      ].join('\n'),
    });

    const report = await collect();
    const dead = report.findings.filter((finding) => finding.kind === 'dead-reference');

    assert.equal(dead.length, 1);
    assert.match(dead[0].detail, /legacy\/exec\.ts is not in the fork any more/);
  });

  test('a file:line citation that points past the end of the file is reported', async () => {
    await base({
      'notes.md': ['# Notes', '', 'See `packages/main/src/exec.ts:9000`.', '', '## What to add here', '- things', ''].join('\n'),
    });

    const report = await collect();

    assert.equal(report.findings[0].kind, 'dead-reference');
    assert.match(report.findings[0].detail, /points past the end/);
  });

  test('a bare filename is a name, not a location, and is left alone', async () => {
    await base({
      'notes.md': ['# Notes', '', 'Touching `extension-api.d.ts` is a compatibility question.', '', '## What to add here', '- things', ''].join('\n'),
    });

    assert.deepEqual((await collect()).findings, []);
  });

  test('paths inside the plugin are not checked against the fork', async () => {
    await base({
      'notes.md': ['# Notes', '', 'The rule lives in `lib/upstream.js`.', '', '## What to add here', '- things', ''].join('\n'),
    });

    assert.deepEqual((await collect()).findings, []);
  });

  test('with no repository to check against, nothing is claimed', async () => {
    await base({
      'notes.md': ['# Notes', '', 'See `packages/gone/src/x.ts`.', '', '## What to add here', '- things', ''].join('\n'),
    });

    assert.deepEqual((await collect({ repoRoot: null })).findings, []);
  });
});

describe('the layer chain', () => {
  const withChain = (chain) =>
    base({
      'package-map.md': ['# Package map', '', '## Layer order', '', '```', chain, '```', '', '## What to add here', '- layers', ''].join('\n'),
    });

  test('a chain shorter than slicing.layer_order is drift, and the missing layers are named', async () => {
    await withChain('extension-api → main → ui');

    const report = await collect();
    const drift = report.findings.filter((finding) => finding.kind === 'layer-drift');

    assert.equal(drift.length, 1);
    assert.match(drift[0].detail, /slicing\.layer_order has tests/);
  });

  test('a chain naming a layer the config does not have is drift the other way', async () => {
    await withChain('extension-api → main → ui → tests → website');

    const report = await collect();

    assert.match(report.findings[0].detail, /the chain names website/);
  });

  test('"renderer + ui" is two layers, not one', () => {
    assert.deepEqual(knowledge.layerChain('```\nmain → renderer + ui → tests\n```'), ['main', 'renderer', 'ui', 'tests']);
  });

  test('a chain that agrees with the config is not a finding', async () => {
    await withChain('extension-api → main → ui → tests');

    assert.deepEqual((await collect()).findings, []);
  });
});

describe('the shape a file declares for itself', () => {
  test('a pitfall missing its fields is reported, by name and by field', async () => {
    await base({
      'pitfalls.md': [
        '# Pitfalls',
        '',
        '## A real one',
        '',
        '**Looks like:** ordinary.',
        '',
        '**Actually:** not.',
        '',
        '**Why it matters:** it costs a review round.',
        '',
        '**Caught by:** the api-surface check.',
        '',
        '## A half-written one',
        '',
        'Something happened once.',
        '',
        '## What to add here',
        '- traps',
        '',
      ].join('\n'),
    });

    const report = await collect();
    const shape = report.findings.filter((finding) => finding.kind === 'entry-shape');

    assert.equal(shape.length, 1);
    assert.match(shape[0].detail, /"A half-written one" is missing Looks like:, Actually:/);
  });

  test('a file with no admission section cannot say what belongs in it', async () => {
    await base({ 'loose.md': '# Loose\n\nSome prose.\n' });

    const report = await collect();

    assert.equal(report.findings[0].kind, 'admission');
    assert.match(report.findings[0].detail, /What to add here/);
  });
});

describe('the boundary', () => {
  test('collect never writes to the base', async () => {
    await base({ 'notes.md': '# Notes\n\nSee `packages/gone/x.ts`.\n' });
    const before_ = await knowledge.files({ dir });

    await collect();
    const after_ = await knowledge.files({ dir });

    assert.deepEqual(after_.map((entry) => entry.text), before_.map((entry) => entry.text));
  });

  test('format says plainly that these are facts and not a revision', async () => {
    await base({ 'notes.md': '# Notes\n\n## What to add here\n- things\n' });

    assert.match(knowledge.format(await collect()), /These are facts, not a revision/);
  });

  test('the export carries the files themselves, one way', async () => {
    await base({ 'notes.md': '# Notes\n\n## First\n\nbody\n\n## What to add here\n- things\n' });

    const entries = await knowledge.exportEntries({ dir });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Notes');
    assert.deepEqual(entries[0].sections, ['First']);
    assert.match(entries[0].text, /body/);
    // There is no import: the files are the source of truth, and a second one
    // would drift (section 8).
    assert.equal('importEntries' in knowledge, false);
  });
});

describe('the shipped base', () => {
  test('checks clean against the plugin\'s own knowledge/ and the fork\'s layer order', async () => {
    const report = await knowledge.collect({
      repoRoot: null,
      home,
      config: {
        slicing: {
          layer_order: [
            'extension-api',
            'api',
            'webview-api',
            'main',
            'preload',
            'renderer',
            'ui',
            'storybook',
            'extensions',
            'tests',
            'website',
          ],
        },
      },
    });

    assert.deepEqual(
      report.findings,
      [],
      `the shipped base has drifted:\n${report.findings.map((finding) => `${finding.file}: ${finding.detail}`).join('\n')}`,
    );
  });
});

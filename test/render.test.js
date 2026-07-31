// SPDX-License-Identifier: Apache-2.0

// Tests for lib/render.js.
//
// Rendering runs against the real templates/ directory rather than fixtures.
// That makes these tests double as a check on the templates themselves: a
// placeholder renamed in a template without its caller being updated fails
// here, which is the whole reason the shape lives in a file.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEMPLATES, render, write } from '../lib/render.js';

let home;

/** Every placeholder a template declares, filled with its own name. */
async function fillAll(template) {
  const file = await readFile(join(process.cwd(), 'templates', TEMPLATES[template]), 'utf8');
  const values = {};
  for (const [, name] of file.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) values[name] = `<${name}>`;
  return values;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-render-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('render', () => {
  test('substitutes values into a shipped template', async () => {
    const text = await render('receipt', await fillAll('receipt'));

    assert.match(text, /# RECEIPT <taskId>/);
    assert.doesNotMatch(text, /\{\{/);
  });

  // An unfilled placeholder in a PR body is visible to a reviewer and reads as
  // carelessness about their time, which is the opposite of what the template
  // is for.
  test('an unfilled placeholder is an error, not a leftover', async () => {
    await assert.rejects(() => render('receipt', { taskId: 'T1' }), /nothing given for/);
  });

  test('the error names every placeholder that was missed, not just the first', async () => {
    await assert.rejects(
      () => render('receipt', {}),
      (error) => {
        assert.match(error.message, /\{\{taskId\}\}/);
        assert.match(error.message, /\{\{command\}\}/);
        return true;
      },
    );
  });

  test('an unknown template is an error', async () => {
    await assert.rejects(() => render('nope', {}), /no template named/);
  });

  // Lists in these templates — steps, owned files, open questions — all read as
  // lines. Array#toString would produce "a,b,c" in an artefact nobody re-reads.
  test('an array becomes lines', async () => {
    const values = { ...(await fillAll('receipt')), files: ['a.ts', 'b.ts'] };
    const text = await render('receipt', values);

    assert.match(text, /a\.ts\nb\.ts/);
  });

  test('null and undefined render as nothing rather than as their names', async () => {
    const values = { ...(await fillAll('receipt')), notes: null, commit: undefined };
    const text = await render('receipt', values);

    assert.doesNotMatch(text, /null|undefined/);
  });

  // The guidance comments are notes to whoever fills the template in. In a
  // pull request body they are one "edit" click from a reviewer.
  test('comments are kept by default and stripped on request', async () => {
    const values = await fillAll('prBody');

    assert.match(await render('prBody', values), /<!--/);
    assert.doesNotMatch(await render('prBody', values, { stripComments: true }), /<!--/);
  });

  test('stripping comments leaves the headings intact', async () => {
    const text = await render('prBody', await fillAll('prBody'), { stripComments: true });

    assert.match(text, /### What does this PR do\?/);
    assert.match(text, /### How to test this PR\?/);
  });

  // Every shipped template has to be renderable at all: a stray brace or a
  // placeholder nobody can fill would only surface when a flow first needed it.
  test('every shipped template renders', async () => {
    for (const name of Object.keys(TEMPLATES)) {
      const text = await render(name, await fillAll(name));
      assert.doesNotMatch(text, /\{\{/, `${name} still has a placeholder after rendering`);
    }
  });
});

describe('write', () => {
  test('writes the artefact under the issue and returns its path', async () => {
    const path = await write({
      issue: 4001,
      template: 'receipt',
      path: 'receipts/T1.md',
      values: await fillAll('receipt'),
      home,
    });

    assert.equal(path, join(home, 'issues', '4001', 'receipts', 'T1.md'));
    assert.match(await readFile(path, 'utf8'), /# RECEIPT <taskId>/);
  });

  test('creates the directories it needs', async () => {
    const path = await write({
      issue: 4002,
      template: 'task',
      path: 'tasks/T7.md',
      values: await fillAll('task'),
      home,
    });

    assert.ok((await readFile(path, 'utf8')).length > 0);
  });
});

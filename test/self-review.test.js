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


// Tests for lib/self-review.js and the `self-review` preflight check.
//
// The question every test here asks: can a review of something other than
// what is being published, or a review with an open finding, let the push
// through? The record ties a review to a commit and a body; the check refuses
// on any mismatch and on anything still open.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as check } from '../lib/preflight/checks/self-review.js';
import * as selfReview from '../lib/self-review.js';

const ISSUE = 7001;
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BODY = '### What does this PR do?\n\nFixes the thing.\n';
const AXES = [...selfReview.AXES];

let home;

beforeEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), 'pdkit-self-review-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The context the check reads, with the commit and body under check. */
const context = (overrides = {}) => ({ issue: ISSUE, slice: undefined, headSha: SHA, prBody: BODY, home, ...overrides });

const record = (overrides = {}) => selfReview.record({ issue: ISSUE, sha: SHA, body: BODY, axes: AXES, findings: [], home, ...overrides });

describe('the record', () => {
  test('refuses a review that did not run all four axes', async () => {
    const result = await record({ axes: ['architecture', 'tests'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /api-compat, product/);
  });

  test('refuses a body nobody could have read, and a sha that is not one', async () => {
    assert.equal((await record({ body: '  ' })).ok, false);
    assert.equal((await record({ sha: 'HEAD' })).ok, false);
  });

  test('refuses a finding with no label, no text, or a section outside 1–12', async () => {
    assert.equal((await record({ findings: [{ label: 'blocker', text: 'x' }] })).ok, false);
    assert.equal((await record({ findings: [{ label: 'issue', text: '' }] })).ok, false);
    assert.equal((await record({ findings: [{ label: 'issue', text: 'x', section: 13 }] })).ok, false);
    assert.equal((await record({ findings: 'none' })).ok, false);
  });

  test('keeps one entry per pull request, the latest one', async () => {
    await record({ findings: [{ label: 'issue', text: 'first' }] });
    await record({ sha: OTHER });
    await record({ slice: 2, findings: [{ label: 'nit', text: 'sliced' }] });

    const stored = await selfReview.read(ISSUE, { home });
    assert.equal(selfReview.entryFor(stored, undefined).sha, OTHER);
    assert.equal(selfReview.entryFor(stored, undefined).findings.length, 0);
    assert.equal(selfReview.entryFor(stored, 2).findings[0].text, 'sliced');

    const raw = JSON.parse(await readFile(join(home, 'issues', String(ISSUE), 'self-review.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw.entries).sort(), ['single', 'slice-2']);
  });

  test('what stays open: every issue, a nit on new code, a question with no answer', async () => {
    const result = await record({
      findings: [
        { label: 'issue', text: 'blocks', section: 2 },
        { label: 'issue', text: 'blocks even when old', preExisting: true },
        { label: 'nit', text: 'new code', section: 4 },
        { label: 'nit', text: 'old code', preExisting: true },
        { label: 'question', text: 'why?' },
        { label: 'question', text: 'answered', answer: 'Notes for reviewers says why' },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.unresolved.map((finding) => finding.text),
      ['blocks', 'blocks even when old', 'new code', 'why?'],
    );
  });

  test('the body digest ignores what GitHub does to line endings and trailing space', () => {
    assert.equal(selfReview.bodyDigest('a\r\nb\n\n'), selfReview.bodyDigest('a\nb'));
    assert.notEqual(selfReview.bodyDigest('a\nb'), selfReview.bodyDigest('a\nc'));
  });
});

describe('the self-review check', () => {
  test('waits for the body: the review reads it, so there is nothing to match before it exists', async () => {
    const result = await check(context({ prBody: null }));
    assert.equal(result.status, 'skip');
    assert.equal(result.waitingFor, 'body');
  });

  test('fails when no review was recorded', async () => {
    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.equal(result.blocking, true);
    assert.match(result.summary, /no self-review is recorded/);
  });

  test('fails when the review read another commit', async () => {
    await record({ sha: OTHER });
    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /read bbbbbbbb, and the branch is at aaaaaaaa/);
  });

  test('fails when the body changed after the review', async () => {
    await record();
    const result = await check(context({ prBody: `${BODY}\nOne more line.\n` }));
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /body changed/);
  });

  test('fails on an open finding and lists it with its section', async () => {
    await record({ findings: [{ label: 'issue', text: 'vi.spyOn on the class under test', path: 'a.spec.ts', line: 12, section: 2 }] });
    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.output, /a\.spec\.ts:12 — issue: vi\.spyOn on the class under test \(§2\)/);
  });

  test('reads the entry of the slice under check, not another one', async () => {
    await record({ slice: 1 });
    assert.equal((await check(context({ slice: 2 }))).status, 'fail');
    assert.equal((await check(context({ slice: 1 }))).status, 'pass');
  });

  test('passes a clean review of this commit and this body', async () => {
    await record({ findings: [{ label: 'nit', text: 'old', preExisting: true }] });
    const result = await check(context({ prBody: BODY.replace(/\n/g, '\r\n') }));
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /nothing open \(1 pre-existing/);
  });
});

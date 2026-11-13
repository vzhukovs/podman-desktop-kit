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

// The line diff a delta review is handed. What these protect: hunks whose
// line numbers point at the wrong line, which send the critic to read the
// wrong part of a plan, and a file present on one side only shown as a blank
// line changed rather than as added or removed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { unified } from '../lib/text-diff.js';

describe('unified', () => {
  test('equal texts have no hunks, and neither do texts that differ only in the final newline', () => {
    assert.deepEqual(unified('a\nb\n', 'a\nb\n'), []);
    assert.deepEqual(unified('a\nb\n', 'a\nb'), []);
  });

  test('changes far apart are separate hunks, each numbered from 1 on both sides', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n';
    const after = 'a\nB\nc\nd\ne\nf\nG\nh\n';
    assert.deepEqual(unified(before, after, { context: 1 }), ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -6,2 +6,3 @@', ' f', '-g', '+G', '+h']);
  });

  test('changes whose context touches share a hunk', () => {
    assert.deepEqual(unified('a\nb\nc\nd\n', 'A\nb\nc\nD\n', { context: 1 }), ['@@ -1,4 +1,4 @@', '-a', '+A', ' b', ' c', '-d', '+D']);
  });

  test('a text absent on one side is all added or all removed, numbered as git numbers it', () => {
    assert.deepEqual(unified('', 'x\ny\n'), ['@@ -0,0 +1,2 @@', '+x', '+y']);
    assert.deepEqual(unified('x\ny\n', ''), ['@@ -1,2 +0,0 @@', '-x', '-y']);
  });

  test('a line inserted between two others names, on the side without it, the line before', () => {
    assert.deepEqual(unified('a\nb\n', 'a\nnew\nb\n', { context: 0 }), ['@@ -1,0 +2,1 @@', '+new']);
  });
});

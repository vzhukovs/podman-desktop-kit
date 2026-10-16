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


// Which comments `pdkit issue fetch` prints. The body is not in question here —
// it is printed whole, always — only the comments, which on podman-desktop run
// to forty on an ordinary issue.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_FLAGS, commentsToShow } from '../lib/cli.js';

const forty = Array.from({ length: 40 }, (_, i) => i + 1);

describe('commentsToShow', () => {
  test('the newest are kept: a discussion converges, and the latest are closest to the answer', () => {
    assert.deepEqual(commentsToShow(forty, { limit: 15 }), { shown: forty.slice(25), hidden: 25 });
  });

  test('--full prints every one', () => {
    assert.deepEqual(commentsToShow(forty, { limit: 15, full: true }), { shown: forty, hidden: 0 });
  });

  test('an issue with fewer comments than the limit loses none', () => {
    assert.deepEqual(commentsToShow([1, 2, 3], { limit: 15 }), { shown: [1, 2, 3], hidden: 0 });
  });

  test('a limit that does not parse prints everything rather than nothing', () => {
    assert.deepEqual(commentsToShow(forty, { limit: 'many' }), { shown: forty, hidden: 0 });
  });

  test('zero is a limit: the header still says how many there are', () => {
    assert.deepEqual(commentsToShow(forty, { limit: 0 }), { shown: [], hidden: 40 });
  });

  test('--full is a flag issue declares, so it is not refused as a typo', () => {
    assert.ok(COMMAND_FLAGS.issue.includes('full'));
  });
});

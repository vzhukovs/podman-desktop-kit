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

// lib/absence.js: what a negative claim looks like, and whether it cites what
// it rests on.
//
// What it protects: an analysis read a cut window and a borrowed name as
// "the field does not exist", and nothing asked what that rested on, because
// the verification convention cites locations and an absence has none.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { citesLocation, citesSearch, proposesAdding, saysAbsent, unsearched } from '../lib/absence.js';

describe('saysAbsent', () => {
  test('reads English negatives', () => {
    for (const text of [
      'The API has no such field.',
      'It does not expose the scheme.',
      'The scheme is not available to extensions.',
    ]) {
      assert.equal(saysAbsent(text), true, text);
    }
  });

  test('does not read "no" inside other words, or a proposal, as absence', () => {
    assert.equal(saysAbsent('The node notes it.'), false);
    assert.equal(saysAbsent('Add `env.uriScheme`.'), false);
  });
});

describe('proposesAdding', () => {
  test('reads proposals', () => {
    assert.equal(proposesAdding('whether `env.uriScheme` should be added'), true);
    assert.equal(proposesAdding('The field holds the scheme.'), false);
  });
});

describe('citations', () => {
  test('a search and a location are each recognized', () => {
    assert.equal(citesSearch('searched: git grep -i scheme -> 0'), true);
    assert.equal(citesSearch('we searched the API'), false);
    assert.equal(citesLocation('`event-store.ts:134-178` has no catch'), true);
    assert.equal(citesLocation('callers catch at `:252`'), true);
    assert.equal(citesLocation('The API has no field.'), false);
  });
});

describe('unsearched', () => {
  test('returns the unlocated, unsearched negatives with their line numbers', () => {
    const text = [
      '## Nothing here',
      '- The API has no field for the scheme.',
      '- `store.ts:54` has no conversion.',
      '- The API has no watchdog. searched: git grep -i watchdog -> 0',
      '- The scheme comes from product.json.',
    ].join('\n');
    assert.deepEqual(unsearched(text), [{ line: 2, text: '- The API has no field for the scheme.' }]);
  });
});

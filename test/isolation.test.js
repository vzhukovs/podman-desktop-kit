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

// The suite runs against a throwaway $PDKIT_HOME, never the person's.
//
// Every other test assumes this and none of them would notice it gone: a test
// that writes to the live journal passes just the same. So the assumption gets
// a test of its own, which fails the run that lost it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

import { DEFAULT_HOME, expandTilde, resolveHome } from '../lib/config.js';

const HOW = 'npm test loads test/helpers/isolate-home.js with --import (see package.json); a run without it reads and writes the live $PDKIT_HOME';

describe('the run is isolated from the live $PDKIT_HOME', () => {
  test('PDKIT_HOME is set', () => {
    assert.ok(process.env.PDKIT_HOME, `PDKIT_HOME is not set. ${HOW}`);
  });

  test('and lies inside the temp directory', () => {
    const inside = relative(tmpdir(), process.env.PDKIT_HOME ?? '');
    assert.ok(
      inside && !inside.startsWith('..') && !isAbsolute(inside),
      `PDKIT_HOME is ${process.env.PDKIT_HOME}, outside ${tmpdir()}. ${HOW}`,
    );
  });

  test('so resolveHome does not reach the default home', () => {
    assert.notEqual(resolveHome(), expandTilde(DEFAULT_HOME), HOW);
  });
});

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

// No test run gets to see the person's $PDKIT_HOME.
//
// Without PDKIT_HOME, resolveHome falls through to ~/.pdkit/podman-desktop —
// live data. A test that forgot to pass `home:` wrote there, and one that
// spawned `bin/pdkit hook pre-bash` left 299 `event:denied` lines in the real
// journal, indistinguishable from the gate's own refusals. Fixing each test
// leaves the next one to forget; this makes forgetting harmless instead.
//
// Loaded by `npm test` as `node --import ./test/helpers/isolate-home.js --test`.
// Checked on Node 22.18 and 24: the orchestrating `node --test` process does
// not run `--import` itself, but passes it on to the process it starts for each
// test file, so every file gets its own fresh home and removes it on exit. The
// `bin/pdkit` processes a test spawns inherit the variable with the rest of the
// environment. An explicit PDKIT_HOME is left alone, so a run can still be
// pointed somewhere on purpose.
//
// `test/isolation.test.js` fails if a run arrives without this.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PDKIT_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'pdkit-test-home-'));
  process.env.PDKIT_HOME = home;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}

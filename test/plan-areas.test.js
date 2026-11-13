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

// A plan's live tasks by area, with the order edges between them.
//
// What these protect: the split /pd:plan-review hands its critics. A task left
// out of every area is a task no critic reads, and a dropped edge is a
// dependency across the cut that neither side sees — the two ways a plan split
// between critics ends up reviewed less than a plan read by one.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parsePlan } from '../lib/artefacts.js';
import { GATE, ROOT, areaOf, planAreas } from '../lib/plan-areas.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 17004;

/**
 * Core tasks in one package, one task across two packages, a file at the top
 * of the repository, test fixtures with one replaced, docs, and a gate.
 */
const PLAN = [
  `# PLAN: DESKTOP-${ISSUE}`,
  '',
  '- Requirements: R1',
  '',
  '## Tasks',
  '### T1: launcher',
  '- Owns: packages/main/src/launcher.ts, packages/main/src/launcher.spec.ts',
  '- Done when: `npx vitest run packages/main/src/launcher.spec.ts`',
  '### T2: api and registry',
  '- Owns: packages/extension-api/src/extension-api.d.ts, packages/main/src/registry.ts',
  '- Done when: `npx vitest run packages/main/src/registry.spec.ts`',
  '### T3: wiring',
  '- Owns: packages/main/src/index.ts',
  '- After: T1, T2',
  '- Done when: `npx vitest run packages/main/src/index.spec.ts`',
  '### T4: desktop file',
  '- Owns: .flatpak.desktop',
  '- Done when: `grep -q scheme .flatpak.desktop`',
  '### T5: fixture',
  '- Owns: tests/playwright/resources/one/package.json',
  '- After: T2',
  '- Done when: `node -e 1`',
  '### T6: fixture, loadable',
  '- Replaces: T5',
  '- Owns: tests/playwright/resources/two/package.json',
  '- After: T2',
  '- Done when: `node -e 1`',
  '### T7: spec',
  '- Owns: tests/playwright/src/specs/handler.spec.ts',
  '- After: T5',
  '- Done when: `npx eslint tests/playwright/src/specs/handler.spec.ts`',
  '### T8: docs',
  '- Owns: website/docs/handler.mdx',
  '- After: T2, T4',
  '- Done when: `npx prettier --check website/docs/handler.mdx`',
  '### T9: gate',
  '- Owns: (none — verification only, writes no files)',
  '- After: T1, T2, T3, T4, T6, T7, T8',
  '- Done when: `pnpm typecheck`',
  '',
].join('\n');

describe('areaOf', () => {
  test('a package or an extension is its own area; anything else is its first directory', () => {
    assert.equal(areaOf('packages/main/src/plugin/index.ts'), 'packages/main');
    assert.equal(areaOf('extensions/podman/packages/extension/src/x.ts'), 'extensions/podman');
    assert.equal(areaOf('tests/playwright/src/specs/x.spec.ts'), 'tests');
    assert.equal(areaOf('website/docs/extensions/x.mdx'), 'website');
    assert.equal(areaOf('storybook/src/x.stories.svelte'), 'storybook');
  });

  test('a file at the top is root; a file directly under packages/ is in packages', () => {
    assert.equal(areaOf('.flatpak.desktop'), ROOT);
    assert.equal(areaOf('package.json'), ROOT);
    assert.equal(areaOf('packages/README.md'), 'packages');
  });

  // A trailing slash names a directory: `packages/main/` is the package itself,
  // not a file called `main` under packages/.
  test('a directory is read as one, and decoration around a path is not part of it', () => {
    assert.equal(areaOf('packages/main/'), 'packages/main');
    assert.equal(areaOf('tests/'), 'tests');
    assert.equal(areaOf('./packages/main/src/x.ts'), 'packages/main');
    assert.equal(areaOf('packages\\main\\src\\x.ts'), 'packages/main');
  });

  test('a wildcard is taken as written rather than guessed at', () => {
    assert.equal(areaOf('packages/*/src/x.ts'), 'packages/*');
    assert.equal(areaOf('*.md'), ROOT);
  });
});

describe('planAreas', () => {
  const plan = parsePlan(PLAN);

  test('every live task is in an area: by Owns, in each area it touches, gate when it owns nothing', () => {
    const { areas } = planAreas(plan);
    assert.deepEqual(
      areas.map((area) => [area.name, area.tasks.map((task) => task.id)]),
      [
        ['packages/main', ['T1', 'T2', 'T3']],
        ['packages/extension-api', ['T2']],
        [ROOT, ['T4']],
        ['tests', ['T6', 'T7']],
        ['website', ['T8']],
        [GATE, ['T9']],
      ],
    );

    // A task in two areas carries, in each, the files it owns there.
    const owns = (name, id) => areas.find((area) => area.name === name)?.tasks.find((task) => task.id === id)?.owns;
    assert.deepEqual(owns('packages/main', 'T2'), ['packages/main/src/registry.ts']);
    assert.deepEqual(owns('packages/extension-api', 'T2'), ['packages/extension-api/src/extension-api.d.ts']);
    assert.deepEqual(owns(GATE, 'T9'), []);
  });

  test('each task names what it waits on and what waits on it', () => {
    const { tasks } = planAreas(plan);
    const edges = Object.fromEntries(tasks.map((task) => [task.id, [task.after, task.waitedOnBy]]));

    assert.deepEqual(edges.T2, [[], ['T3', 'T6', 'T8', 'T9']]);
    assert.deepEqual(edges.T9, [['T1', 'T2', 'T3', 'T4', 'T6', 'T7', 'T8'], []]);
    // `After: T5` is read as what replaced T5, as exec reads it.
    assert.deepEqual(edges.T7, [['T6'], ['T9']]);
    assert.deepEqual(edges.T6, [['T2'], ['T7', 'T9']]);
    assert.deepEqual(tasks.find((task) => task.id === 'T2')?.areas, ['packages/extension-api', 'packages/main']);
  });

  test('a replaced or withdrawn task is in no area, and is listed as left out', () => {
    const replaced = planAreas(plan);
    assert.deepEqual(replaced.notLive, ['T5']);
    assert.ok(replaced.areas.every((area) => area.tasks.every((task) => task.id !== 'T5')));

    // T4 withdrawn with no replacement: its area goes, and nothing waits on it.
    const withdrawn = planAreas(plan, { T4: {} });
    assert.deepEqual(withdrawn.notLive, ['T4', 'T5']);
    assert.equal(withdrawn.areas.some((area) => area.name === ROOT), false);
    assert.deepEqual(withdrawn.tasks.find((task) => task.id === 'T8')?.after, ['T2']);
  });
});

// End to end through bin/pdkit.
describe('pdkit plan areas', () => {
  let home;
  const homes = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-areas-'));
    homes.push(home);
    await mkdir(join(home, 'issues', String(ISSUE)), { recursive: true });
    await writeFile(join(home, 'issues', String(ISSUE), 'plan.md'), PLAN);
  });
  after(async () => {
    for (const path of homes) await rm(path, { recursive: true, force: true });
  });

  async function pdkit(...args) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: home, env: { ...process.env, PDKIT_HOME: home }, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  }

  test('prints each area with its tasks, an edge out of the area naming where it goes', async () => {
    const out = await pdkit('plan', 'areas', String(ISSUE));
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`^plan areas: issue ${ISSUE} — 8 live task\\(s\\) in 6 area\\(s\\)$`, 'm'));
    assert.match(out.stdout, /^packages\/main: T1, T2, T3$/m);
    assert.match(out.stdout, /^gate: T9$/m);

    // T2 inside packages/main: T3 waits on it from the same area, T6 from tests.
    const [, main] = /^packages\/main:[^\n]*\n([\s\S]*?)\n\n/m.exec(out.stdout) ?? [];
    assert.match(main, /^ {6}waited on by {3}T3, T6 \(tests\), T8 \(website\), T9 \(gate\)$/m);
    assert.match(main, /^ {6}also in {8}packages\/extension-api$/m);
    assert.match(out.stdout, /^ {6}owns {11}nothing — a verification$/m);
    assert.match(out.stdout, /^not live, so in no area: T5 — replaced or withdrawn$/m);
  });

  test('--json carries the areas, the edges, and what was left out', async () => {
    const out = await pdkit('plan', 'areas', String(ISSUE), '--json');
    assert.equal(out.code, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.issue, ISSUE);
    assert.deepEqual(
      parsed.areas.map((area) => area.name),
      ['packages/main', 'packages/extension-api', ROOT, 'tests', 'website', GATE],
    );
    assert.deepEqual(parsed.notLive, ['T5']);
  });

  test('refuses an issue with no plan, and no issue at all', async () => {
    const none = await pdkit('plan', 'areas', '17005');
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /plan\.md does not exist/);
    assert.match((await pdkit('plan', 'areas')).stderr, /an issue number is required/);
  });
});

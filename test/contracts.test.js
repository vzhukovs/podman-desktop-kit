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

// Contract for lib/contracts.js: which IPC channels a change touches.
//
// The shapes below are the two from DESKTOP-19818, cut down. In main the
// channel string sits ABOVE the parameters that changed; in preload the
// `ipcInvoke` sits BELOW them. A detector that only read the changed lines,
// or a few lines around them, would find one side and not the other, and the
// split it exists to refuse would pass.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { blocksOf, changedLines, channelsIn, hasChannels, touchedChannels } from '../lib/contracts.js';
import * as slice from '../lib/slice.js';
import * as state from '../lib/state.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const MAIN_BEFORE = [
  'export class PluginSystem {',
  '  init(): void {',
  '    this.ipcHandle(',
  "      'image-checker:check',",
  '      async (',
  '        _listener,',
  '        id: string,',
  '        image: ImageInfo,',
  '      ): Promise<unknown> => {',
  "        // a comment with a ) in it, and a string ')' too",
  '        return imageChecker.check(id, image);',
  '      },',
  '    );',
  '',
  "    this.ipcHandle('other:channel', async () => 'untouched');",
  '  }',
  '',
  '  helper(): string {',
  "    return 'not a handler';",
  '  }',
  '}',
  '',
].join('\n');

const MAIN_AFTER = MAIN_BEFORE.replace('        image: ImageInfo,\n', '        engineId: string,\n        imageId: string,\n').replace(
  '        return imageChecker.check(id, image);',
  '        const image = await registry.getImageInfo(engineId, imageId);\n        return imageChecker.check(id, image);',
);

const PRELOAD_BEFORE = [
  'export function initExposure(): void {',
  '  contextBridge.exposeInMainWorld(',
  "    'imageCheck',",
  '    async (',
  '      id: string,',
  '      image: ImageInfo,',
  '    ): Promise<unknown> => {',
  "      return ipcInvoke('image-checker:check', id, image);",
  '    },',
  '  );',
  '}',
  '',
].join('\n');

const PRELOAD_AFTER = PRELOAD_BEFORE.replace('      image: ImageInfo,\n', '      engineId: string,\n      imageId: string,\n').replace(
  "ipcInvoke('image-checker:check', id, image)",
  "ipcInvoke('image-checker:check', id, engineId, imageId)",
);

describe('blocksOf', () => {
  test('a block runs from the anchor to the parenthesis that closes it, past strings and comments', () => {
    const blocks = blocksOf(MAIN_BEFORE);

    assert.deepEqual(
      blocks.map((block) => [block.start, block.end, block.channels]),
      [
        [3, 13, ['image-checker:check']],
        [15, 15, ['other:channel']],
      ],
    );
  });

  test('in preload the channel is found below the exposed name, inside the same call', () => {
    assert.deepEqual(blocksOf(PRELOAD_BEFORE), [{ start: 2, end: 10, channels: ['image-checker:check'] }]);
  });

  test('code outside any registration belongs to no channel', () => {
    assert.equal(blocksOf('export const x = 1;\nfunction ipcInvoke(channel: string) {}\n').length, 0);
  });
});

describe('changedLines', () => {
  test('reads old and new numbers from zero-context hunks, including the one-line form', () => {
    const diff = ['@@ -8 +8,2 @@', '-a', '+b', '+c', '@@ -11,0 +13 @@', '+d'].join('\n');
    assert.deepEqual(changedLines(diff), { removed: [8], added: [8, 9, 13] });
  });
});

describe('touchedChannels', () => {
  const diff = (before, after) => {
    // A hand-made zero-context diff is enough: only the hunk headers are read.
    const old = before.split('\n');
    const next = after.split('\n');
    let first = 0;
    while (old[first] === next[first]) first += 1;
    let tail = 0;
    const room = Math.min(old.length, next.length) - first;
    while (tail < room && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
    return `@@ -${first + 1},${old.length - first - tail} +${first + 1},${next.length - first - tail} @@\n`;
  };

  test('the handler side of a changed signature is found, though the channel is above the change', () => {
    assert.deepEqual(touchedChannels({ before: MAIN_BEFORE, after: MAIN_AFTER, diff: diff(MAIN_BEFORE, MAIN_AFTER) }), [
      { channel: 'image-checker:check', existed: true },
    ]);
  });

  test('the calling side is found, and the untouched channel beside it is not', () => {
    assert.deepEqual(touchedChannels({ before: PRELOAD_BEFORE, after: PRELOAD_AFTER, diff: diff(PRELOAD_BEFORE, PRELOAD_AFTER) }), [
      { channel: 'image-checker:check', existed: true },
    ]);
  });

  test('a channel added by the change did not exist', () => {
    const after = `${MAIN_BEFORE}\nthis.ipcHandle('brand:new', async () => 1);\n`;
    assert.deepEqual(touchedChannels({ before: MAIN_BEFORE, after, diff: diff(MAIN_BEFORE, after) }), [{ channel: 'brand:new', existed: false }]);
  });

  // hasChannels was CHANNEL.test(), which moves a global expression's
  // lastIndex; the next file's matchAll then started mid-text and found
  // nothing. Facts came back with no channels at all, and the split passed.
  test('asking whether a text has channels does not hide the next text’s', () => {
    assert.equal(hasChannels(PRELOAD_BEFORE), true);
    assert.equal(blocksOf("this.ipcHandle('x', async (a) => a);\n").length, 1);
  });

  test('channelsIn names every channel in a text', () => {
    assert.deepEqual([...channelsIn(PRELOAD_AFTER)], ['image-checker:check']);
  });
});

// The rule itself lives in build(), and this is the path the slicer takes to
// it: facts read both sides from git, and set refuses the layer split.
describe('slice set over a channel split by layer', () => {
  const ISSUE = 4343;
  const MAIN = 'packages/main/src/plugin/index.ts';
  const PRELOAD = 'packages/preload/src/index.ts';
  let repo;
  let home;
  let collected;

  const map = {
    layers: ['main', 'preload', 'other'],
    packages: {
      '@fixture/main': { path: 'packages/main', layer: 'main' },
      '@fixture/preload': { path: 'packages/preload', layer: 'preload' },
    },
  };
  const CONFIG = { repo: { base_branch: 'main' }, branches: { sliced: 'DESKTOP-{issue}/{index}-{slug}' }, slicing: { layer_order: ['main', 'preload'] } };

  before(async () => {
    repo = await initRepo('pdkit-contracts-');
    home = await initRepo('pdkit-contracts-home-');

    await writeFiles(repo, { [MAIN]: MAIN_BEFORE, [PRELOAD]: PRELOAD_BEFORE });
    await commitAll(repo, 'chore: seed');
    await git(['checkout', '-b', `DESKTOP-${ISSUE}/work`], repo);
    await writeFiles(repo, { [MAIN]: MAIN_AFTER, [PRELOAD]: PRELOAD_AFTER });
    await commitAll(repo, 'refactor: resolve images by engine and id');

    await state.transition(ISSUE, 'triaged', { home });
    collected = await slice.facts({ issue: ISSUE, repoRoot: repo, home, config: CONFIG, packageMap: map });
  });

  after(async () => {
    await cleanup(repo, home);
  });

  test('facts carry the channel on both files, read from git', () => {
    const byPath = new Map(collected.files.map((file) => [file.path, file.channels]));
    assert.deepEqual(byPath.get(MAIN), [{ channel: 'image-checker:check', existed: true }]);
    assert.deepEqual(byPath.get(PRELOAD), [{ channel: 'image-checker:check', existed: true }]);
  });

  test('one slice per layer is refused, by channel, with both files named', () => {
    const result = slice.build({
      issue: ISSUE,
      facts: collected,
      config: CONFIG,
      proposal: {
        slices: [
          { slug: 'main', title: 'main', files: [MAIN] },
          { slug: 'preload', title: 'preload', files: [PRELOAD] },
        ],
      },
    });

    assert.equal(result.ok, false);
    const refusal = result.problems.find((problem) => problem.check === 'ipc-contract');
    assert.match(refusal.detail, /"image-checker:check" changes in #1 \(packages\/main\/src\/plugin\/index\.ts\) and #2/);
    assert.match(slice.refusalAdvice(result.problems).join('\n'), /one commit per layer/);
  });

  test('stacking does not make an existing contract safe to split', () => {
    const result = slice.build({
      issue: ISSUE,
      facts: collected,
      config: CONFIG,
      proposal: {
        slices: [
          { slug: 'main', title: 'main', files: [MAIN] },
          { slug: 'preload', title: 'preload', files: [PRELOAD], baseSlice: 1 },
        ],
      },
    });

    assert.ok(result.problems.some((problem) => problem.check === 'ipc-contract'));
  });

  test('both ends in one slice is accepted', () => {
    const result = slice.build({ issue: ISSUE, facts: collected, config: CONFIG, proposal: { slices: [{ slug: 'all', title: 'all', files: [MAIN, PRELOAD] }] } });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
  });

  test('a new channel split across a stack is a warning, and across independent slices a refusal', () => {
    const fresh = {
      ...collected,
      files: collected.files.map((file) => ({ ...file, channels: [{ channel: 'brand:new', existed: false }] })),
    };
    const cut = (baseSlice) => ({
      slices: [
        { slug: 'main', title: 'main', files: [MAIN] },
        { slug: 'preload', title: 'preload', files: [PRELOAD], baseSlice },
      ],
    });

    const stacked = slice.build({ issue: ISSUE, facts: fresh, config: CONFIG, proposal: cut(1) });
    assert.equal(stacked.ok, true, JSON.stringify(stacked.problems));
    assert.ok(stacked.warnings.some((warning) => warning.check === 'ipc-contract'));

    const apart = slice.build({ issue: ISSUE, facts: fresh, config: CONFIG, proposal: cut(null) });
    assert.ok(apart.problems.some((problem) => /neither is stacked/.test(problem.detail)));
  });
});

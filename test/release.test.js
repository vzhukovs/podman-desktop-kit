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

// The version has to be one number in three files, and this is the only thing
// that can say so.
//
// Claude Code resolves an installed plugin's version from plugin.json first and
// SKIPS the update when it matches what is already on disk. So a release shipped
// without bumping that field does not reach anybody: `/plugin update` reports
// "already at the latest version", every colleague stays on the old copy, and
// nothing anywhere reports a problem. There is no runtime symptom to notice —
// which is exactly the shape of failure this repository keeps finding, and the
// reason it gets a test rather than a line in a runbook.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const read = async (...parts) => readFile(join(ROOT, ...parts), 'utf8');
const json = async (...parts) => JSON.parse(await read(...parts));

/** `## [1.2.3] - 2026-08-10`, newest first in a Keep a Changelog file. */
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm;

describe('the version is one number', () => {
  test('plugin.json and package.json agree', async () => {
    const plugin = await json('.claude-plugin', 'plugin.json');
    const pkg = await json('package.json');

    assert.match(plugin.version, /^\d+\.\d+\.\d+$/, 'plugin.json carries no semver version');
    assert.equal(
      plugin.version,
      pkg.version,
      'plugin.json and package.json disagree — the first is what decides whether an update reaches anyone',
    );
  });

  test('the newest changelog entry is that version', async () => {
    const plugin = await json('.claude-plugin', 'plugin.json');
    const [newest] = [...(await read('CHANGELOG.md')).matchAll(RELEASE_HEADING)];

    assert.ok(newest, 'CHANGELOG.md has no `## [x.y.z]` release heading at all');
    assert.equal(
      newest[1],
      plugin.version,
      `CHANGELOG.md's newest release is ${newest[1]} and the manifest says ${plugin.version}`,
    );
    assert.ok(newest[2], `the ${newest[1]} heading carries no date`);
  });

  // Two version fields is two places to forget one. plugin.json wins when both
  // are set, so an entry that also carries a version is not an override — it is
  // a value that silently does nothing until the day the two disagree.
  test('the marketplace entry does not carry its own version', async () => {
    const marketplace = await json('.claude-plugin', 'marketplace.json');

    for (const entry of marketplace.plugins) {
      assert.equal(entry.version, undefined, `the ${entry.name} entry pins a version; plugin.json is the source`);
    }
  });

  test('the marketplace names the plugin the install command uses', async () => {
    const marketplace = await json('.claude-plugin', 'marketplace.json');
    const plugin = await json('.claude-plugin', 'plugin.json');

    // `/plugin install <entry name>@<marketplace name>`, and the skills are
    // namespaced by plugin.json's name. README documents `/pd:*` and
    // `pd@podman-desktop-kit`, and both only hold while these agree.
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, plugin.name);
  });
});

describe('the changelog stays readable as a changelog', () => {
  test('it keeps an Unreleased section to write the next entry into', async () => {
    assert.match(await read('CHANGELOG.md'), /^## \[Unreleased\]$/m);
  });

  test('every release heading has a link definition', async () => {
    const changelog = await read('CHANGELOG.md');

    for (const [, version] of changelog.matchAll(RELEASE_HEADING)) {
      assert.match(
        changelog,
        new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: `, 'm'),
        `[${version}] has no link definition at the bottom`,
      );
    }
  });
});

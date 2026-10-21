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

// Preflight check: maintainer rules
//
// The greppable part of knowledge/maintainer-rules.md, in the added lines.
// Those are the rules upstream's review agent applies to every pull request,
// and each pattern below is one the calibration there names as blocking in
// practice: vi.spyOn in a new test, an unchecked cast, an exported function
// in packages/main, a relative import, a hardcoded product name or colour.
//
// A warning, not a blocker, for the reason debug-leftovers gives: a grep
// cannot see context, and every one of these has a legitimate exception
// somewhere. What it buys is timing — the implementer hears about vi.spyOn
// before the maintainer does.
//
// Added lines only, which is the calibration's own line: a violation that
// already existed in a touched file is not this branch's finding.
//
// Each pattern is scoped to the files its rule is about. `afterEach` in a
// Playwright spec or `export function` in an extension is not a violation,
// and a check that says it is gets ignored by the second run.

import { capture } from '../../evidence.js';

/** @type {string} */
export const id = 'maintainer-rules';

/** @type {boolean} */
export const blocking = false;

const SPEC = /\.(?:spec|test)\.ts$/;
const SOURCE = /\.(?:ts|svelte)$/;
const PACKAGES = /^packages\//;
const MAIN_SOURCE = /^packages\/main\/src\/.*\.ts$/;

/** Unit specs, not Playwright: tests/playwright has its own conventions. */
const unitSpec = (path) => SPEC.test(path) && PACKAGES.test(path);
/** Production code under packages/, specs excluded. */
const packageSource = (path) => SOURCE.test(path) && PACKAGES.test(path) && !SPEC.test(path) && !path.endsWith('.d.ts');

const NODE_BUILTINS = 'fs|path|os|child_process|crypto|url|util|events|stream|http|https|net|zlib|readline|assert|buffer|process|timers';

/**
 * @typedef {object} Pattern
 * @property {string} label
 * @property {number} section    of knowledge/maintainer-rules.md
 * @property {(path: string) => boolean} applies
 * @property {RegExp} test
 */

/** @type {Pattern[]} */
const PATTERNS = [
  { label: 'vi.spyOn', section: 2, applies: unitSpec, test: /\bvi\.spyOn\s*\(/ },
  { label: 'Object.defineProperty(window)', section: 2, applies: unitSpec, test: /\bObject\.defineProperty\s*\(\s*window\b/ },
  { label: 'vi.stubGlobal', section: 2, applies: unitSpec, test: /\bvi\.stubGlobal\s*\(/ },
  { label: 'clearAllMocks/restoreAllMocks', section: 2, applies: unitSpec, test: /\bvi\.(?:clearAllMocks|restoreAllMocks)\s*\(/ },
  { label: 'afterEach/afterAll/beforeAll', section: 2, applies: unitSpec, test: /^\s*(?:afterEach|afterAll|beforeAll)\s*\(/ },
  { label: 'await tick()', section: 2, applies: unitSpec, test: /\bawait\s+tick\s*\(\s*\)/ },
  { label: 'as unknown as', section: 4, applies: (path) => SOURCE.test(path) && PACKAGES.test(path), test: /\bas\s+unknown\s+as\b/ },
  { label: 'eslint-disable', section: 4, applies: (path) => SOURCE.test(path) && PACKAGES.test(path), test: /eslint-disable/ },
  { label: 'synchronous fs/exec', section: 4, applies: packageSource, test: /\b(?:exec|execFile|spawn|readFile|writeFile|appendFile|readdir|exists|mkdir|stat|lstat|access|copyFile|rename|rm|rmdir|unlink|realpath)Sync\s*\(/ },
  { label: 'relative ../ import', section: 5, applies: (path) => SOURCE.test(path) && PACKAGES.test(path), test: /\bfrom\s+['"]\.\.\// },
  { label: 'node built-in without node:', section: 5, applies: (path) => SOURCE.test(path) && PACKAGES.test(path), test: new RegExp(`\\bfrom\\s+['"](?:${NODE_BUILTINS})(?:/[a-z]+)?['"]`) },
  { label: 'export function in packages/main', section: 6, applies: (path) => MAIN_SOURCE.test(path) && !SPEC.test(path), test: /^export\s+(?:async\s+)?function\b/ },
  { label: '<style> or style= in Svelte', section: 3, applies: (path) => path.endsWith('.svelte'), test: /<style\b|\sstyle=/ },
  { label: '$: in Svelte', section: 3, applies: (path) => path.endsWith('.svelte'), test: /^\s*\$:/ },
  { label: 'hardcoded "Podman Desktop"', section: 8, applies: packageSource, test: /['"`][^'"`]*\bPodman Desktop\b/ },
  { label: 'hex colour in color-registry', section: 8, applies: (path) => /color-registry\.ts$/.test(path), test: /['"]#[0-9a-fA-F]{3,8}['"]/ },
];

/**
 * A licence header naming a year other than this one, or a range.
 *
 * Kept apart from PATTERNS because "this year" is not a constant.
 *
 * @param {string} line
 * @param {number} year
 */
export function staleCopyright(line, year) {
  const match = /Copyright \(C\) (\d{4})(-\d{4})?/.exec(line);
  return match !== null && (match[2] !== undefined || Number(match[1]) !== year);
}

/**
 * @param {import('../index.js').PreflightContext} context
 * @param {{year?: number}} [options]
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context, options = {}) {
  const year = options.year ?? new Date().getFullYear();
  const diff = await capture({
    command: `git diff ${context.base}...${context.ref} --unified=0`,
    cwd: context.repoRoot,
  });

  /** @type {Record<string, {section: number, lines: string[]}>} */
  const found = {};
  let file = '';

  for (const raw of diff.stdout.split('\n')) {
    // Same CRLF care as debug-leftovers: the `\r` would otherwise end up in
    // the captured filename and in every reported line.
    const line = raw.replace(/\r$/, '');
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    const added = line.slice(1);
    const hits = PATTERNS.filter((pattern) => pattern.applies(file) && pattern.test.test(added));
    if (staleCopyright(added, year)) hits.push({ label: `copyright not ${year} alone`, section: 1 });

    for (const hit of hits) {
      (found[hit.label] ??= { section: hit.section, lines: [] }).lines.push(`${file}: ${added.trim()}`);
    }
  }

  const labels = Object.keys(found);
  if (labels.length === 0) return { id, status: 'pass', blocking, summary: 'none of the greppable maintainer rules hit' };

  return {
    id,
    status: 'warn',
    blocking,
    summary: labels.map((label) => `${label} ×${found[label].lines.length} (§${found[label].section})`).join(', '),
    output: labels.map((label) => `${label} — §${found[label].section}\n  ${found[label].lines.join('\n  ')}`).join('\n\n'),
    remedy: 'upstream\'s review agent raises each of these; the rule and its reason are in knowledge/maintainer-rules.md under the section named',
  };
}

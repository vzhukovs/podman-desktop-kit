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

// Preflight check: debug leftovers
//
// console.log, .only, .skip, @ts-ignore and bare `any` in the added lines.
//
// A warning, not a blocker, and the difference is deliberate. Every one of
// these is sometimes correct — a console.log in a CLI script, an `any` at a
// boundary that genuinely has none — so blocking would train people to work
// around the gate. Listing them is enough: the point is that nobody discovers
// a stray .only in review.
//
// `.only` is the exception that would justify blocking, since it silently
// disables the rest of a suite. It is called out first in the summary instead.

import { capture } from '../../evidence.js';

/** @type {string} */
export const id = 'debug-leftovers';

/** @type {boolean} */
export const blocking = false;

const PATTERNS = [
  { label: '.only', test: /\b(?:describe|test|it)\.only\b/ },
  { label: '.skip', test: /\b(?:describe|test|it)\.skip\b/ },
  { label: 'console.log', test: /\bconsole\.log\s*\(/ },
  { label: '@ts-ignore', test: /@ts-ignore\b/ },
  { label: '@ts-nocheck', test: /@ts-nocheck\b/ },
  { label: 'any', test: /:\s*any\b|\bas\s+any\b/ },
];

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const diff = await capture({
    command: `git diff ${context.base}...${context.ref} --unified=0`,
    cwd: context.repoRoot,
  });

  /** @type {Record<string, string[]>} */
  const found = {};
  let file = '';

  for (const raw of diff.stdout.split('\n')) {
    // The `\r` goes before anything reads the line. `(.+)$` would otherwise
    // capture it into the filename on a repository checked out with CRLF, and
    // every leftover would then be reported against a path with an invisible
    // character on the end.
    const line = raw.replace(/\r$/, '');
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    for (const pattern of PATTERNS) {
      if (pattern.test.test(line)) (found[pattern.label] ??= []).push(`${file}: ${line.slice(1).trim()}`);
    }
  }

  const labels = Object.keys(found);
  if (labels.length === 0) return { id, status: 'pass', blocking, summary: 'none' };

  const counts = labels.map((label) => `${label} ×${found[label].length}`);
  const urgent = found['.only'] ? '.only disables the rest of the suite — ' : '';

  return {
    id,
    status: 'warn',
    blocking,
    summary: `${urgent}${counts.join(', ')}`,
    output: labels.map((label) => `${label}\n  ${found[label].join('\n  ')}`).join('\n\n'),
  };
}

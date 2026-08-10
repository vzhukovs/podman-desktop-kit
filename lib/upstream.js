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

// Primitives for the upstream rules of podman-desktop.
//
// Shared on purpose: hooks enforce these live (post-write SPDX, commit checks)
// and preflight verifies them in batch. Two implementations of "what counts as
// a valid SPDX header" would eventually disagree, and the disagreement would
// surface as a hook passing something preflight then rejects.
//
// Every constant here was measured against the repository rather than assumed.
// Where the measurement is surprising, the number is in the comment, so the
// next reader can re-check it instead of trusting this file.

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** The identifier line, wherever it appears. */
export const SPDX_HEADER = 'SPDX-License-Identifier: Apache-2.0';

/**
 * Conventional commit types accepted upstream.
 *
 * This is the list @commitlint/config-conventional enforces, which is what
 * .husky/commit-msg actually runs. CONTRIBUTING.md names the same set minus
 * `revert`; the enforcer wins, because it is the thing that will reject the
 * commit.
 */
export const COMMIT_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
];

/**
 * File extensions that require an SPDX header.
 *
 * Measured against podman-desktop, not assumed, and the measurement changed
 * the list twice:
 *
 *   .ts   1609/1612 carry it      .svelte    0/589
 *   .js     39/45                 .css       0/5
 *   .mjs     2/2                  .tsx       5/27, and all 27 are in website/
 *   .cjs     4/5
 *
 * The skeleton required .svelte, .css and .scss. That would have blocked every
 * new Svelte component, and UI work in this repository is mostly Svelte
 * components. .tsx was added here and then removed: it exists only in the
 * docusaurus site, where the convention is the opposite one.
 *
 * Auditing every tracked file with the list below flags 10 of 1664 (0.6%),
 * and all ten are legacy stragglers: three tooling files (commitlint.config.cjs,
 * storybook/tailwind.config.js, scripts/update-electron-vendors.js) and seven
 * under website/. No path exemption removes them without also exempting the
 * 31 of 33 config files that do carry the header, so the residue is left as
 * is — this check fires on files being written rather than on an audit, and
 * adding a license header is never wrong.
 */
export const SPDX_REQUIRED_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs'];

/** The house header, as it appears in the repository. */
const RULE_OPEN = `/${'*'.repeat(70)}`;
const RULE_CLOSE = ` ${'*'.repeat(71)}/`;

/**
 * Whether the copyright line is there. The year is written four different ways
 * across the repository — `2024`, `2022-2024`, `2022, 2024`, `2022 - 2024` —
 * so it is not part of the test.
 */
const COPYRIGHT = /^\s*\*\s*Copyright \(C\).*Red Hat, Inc\./m;

/**
 * The header a new file must carry.
 *
 * @param {number} [year]
 * @returns {string}
 */
export function spdxHeader(year = new Date().getFullYear()) {
  return [
    RULE_OPEN,
    ` * Copyright (C) ${year} Red Hat, Inc.`,
    ' *',
    ' * Licensed under the Apache License, Version 2.0 (the "License");',
    ' * you may not use this file except in compliance with the License.',
    ' * You may obtain a copy of the License at',
    ' *',
    ' * http://www.apache.org/licenses/LICENSE-2.0',
    ' *',
    ' * Unless required by applicable law or agreed to in writing, software',
    ' * distributed under the License is distributed on an "AS IS" BASIS,',
    ' * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.',
    ' * See the License for the specific language governing permissions and',
    ' * limitations under the License.',
    ' *',
    ` * ${SPDX_HEADER}`,
    RULE_CLOSE,
    '',
  ].join('\n');
}

/**
 * Whether a file needs an SPDX header, and whether it has one.
 *
 * "Has one" means the house format: the Red Hat Apache block with the
 * identifier inside it. A bare `// SPDX-License-Identifier: Apache-2.0` line is
 * not the repository's format and gets asked about in review, so accepting it
 * here would teach the hook to pass what a reviewer then rejects.
 *
 * @param {{path: string, content: string}} file
 * @returns {{required: boolean, present: boolean, insert: string|null}}
 */
export function checkSpdx(file) {
  const required = SPDX_REQUIRED_EXTENSIONS.includes(extname(String(file?.path ?? '')));
  if (!required) return { required: false, present: false, insert: null };

  const content = String(file?.content ?? '');
  const present = content.includes(SPDX_HEADER) && COPYRIGHT.test(content);

  return { required: true, present, insert: present ? null : spdxHeader() };
}

/** `type(scope)!: description`, with scope and `!` both optional. */
const SUBJECT = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

/**
 * Parse a commit subject into type, scope, and description.
 *
 * @param {string} subject
 * @returns {{type: string, scope: string|null, description: string, breaking: boolean}|null} null when it does not parse
 */
export function parseCommitSubject(subject) {
  const match = SUBJECT.exec(String(subject ?? '').trim());
  if (!match) return null;

  return {
    type: match[1].toLowerCase(),
    scope: match[2] === undefined || match[2] === '' ? null : match[2],
    description: match[4].trim(),
    breaking: match[3] === '!',
  };
}

/**
 * Validate a commit against upstream rules.
 *
 * `problems` blocks and `notes` does not, and the split is the whole point of
 * this function. The scope is **not** required upstream: commitlint extends
 * config-conventional and CONTRIBUTING.md writes the format as
 * `<type>[optional scope]`, so scope-less subjects land on main regularly.
 * Treating a missing scope as a defect would make preflight reject valid work
 * — and would make /pd:review-pr complain about other people's PRs for
 * following their own repository's rules.
 *
 * @param {{subject: string, trailers?: Record<string, string[]>}} commit
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function validateCommit(commit) {
  const problems = [];
  const notes = [];

  const parsed = parseCommitSubject(commit?.subject);
  if (!parsed) {
    problems.push(`"${commit?.subject ?? ''}" is not a conventional commit subject (expected "type(scope): description")`);
  } else {
    if (!COMMIT_TYPES.includes(parsed.type)) {
      problems.push(`"${parsed.type}" is not one of the accepted types: ${COMMIT_TYPES.join(', ')}`);
    }
    if (parsed.scope === null) {
      notes.push('no package scope — upstream does not require one, but it tells a reviewer which area they are being asked about');
    }
  }

  // .husky/commit-msg appends the trailer when missing and then rejects the
  // message if it appears twice. Both halves are failures here, and the
  // duplicate is the one that surprises people: it is what `git rebase -i`
  // produces when squashing commits that each already carry a sign-off.
  const signOffs = commit?.trailers?.['Signed-off-by'] ?? [];
  if (signOffs.length === 0) {
    problems.push('no Signed-off-by trailer — commit with -s, or let the husky hook add it');
  } else if (signOffs.length > 1) {
    problems.push(
      `${signOffs.length} Signed-off-by trailers; the husky commit-msg hook rejects duplicates. ` +
        'This is what rebase -i produces when squashing signed commits — use git reset --soft <base> && git commit instead',
    );
  }

  return { ok: problems.length === 0, problems, notes };
}

/** Where the public surface is declared. */
export const EXTENSION_API_DTS = join('packages', 'extension-api', 'src', 'extension-api.d.ts');

/** `export interface RunOptions` and friends. */
const DECLARATION = /\b(?:interface|type|class|enum|namespace|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/**
 * Whether changed symbols are part of the public extension API surface.
 *
 * This is the RunOptions trap codified: a type can live in
 * packages/main/src/plugin/util/exec.ts and look like an internal helper while
 * also being declared in extension-api.d.ts, which makes it public API. It is a
 * grep, not a judgement call, which is exactly why it belongs in code.
 *
 * @param {{symbols: string[], repoRoot: string}} input
 * @returns {Promise<Array<{symbol: string, public: boolean, declaredAt: string|null}>>}
 */
export async function classifyApiSurface(input) {
  const symbols = input?.symbols ?? [];
  if (symbols.length === 0) return [];

  let lines;
  try {
    lines = (await readFile(join(input.repoRoot, EXTENSION_API_DTS), 'utf8')).split('\n');
  } catch {
    // No public surface file: nothing can be public through it. Reported as
    // "not public" rather than thrown, so a repository laid out differently
    // still runs the rest of preflight.
    return symbols.map((symbol) => ({ symbol, public: false, declaredAt: null }));
  }

  return symbols.map((symbol) => {
    const word = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

    let firstMention = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (!word.test(lines[i])) continue;

      const declared = DECLARATION.exec(lines[i]);
      // A declaration is the strongest answer; a mention still counts, because
      // a type used in a public signature is public whether or not this file
      // is where it was written.
      if (declared && declared[1] === symbol) {
        return { symbol, public: true, declaredAt: `${EXTENSION_API_DTS}:${i + 1}` };
      }
      firstMention ??= `${EXTENSION_API_DTS}:${i + 1}`;
    }

    return { symbol, public: firstMention !== null, declaredAt: firstMention };
  });
}

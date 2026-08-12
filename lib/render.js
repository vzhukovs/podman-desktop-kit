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

// Rendering templates/*.md into the artefacts under $PDKIT_HOME.
//
// Templates are the shape of an artefact; this module fills them. Keeping the
// shape in a file rather than in a prompt means a missing section is a diff,
// not a matter of whether the model remembered it this time.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PLUGIN_ROOT, get, issueDir, load, resolveHome } from './config.js';
import { gh } from './gh.js';

/** Templates shipped with the plugin, by artefact name. */
export const TEMPLATES = {
  issue: 'issue.md',
  archaeology: 'archaeology.md',
  plan: 'plan.md',
  task: 'task.md',
  receipt: 'receipt.md',
  validation: 'validation.md',
  slices: 'slices.md',
  prBody: 'pr-body.md',
  prTracking: 'pr-tracking.md',
  reviewReport: 'review-report.md',
  planAmendment: 'plan-amendment.md',
  findings: 'findings.md',
  deferral: 'deferral.md',
};

/** `{{name}}`, with whitespace tolerated inside the braces. */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** An HTML comment, including the newline it sits on. */
const COMMENT = /^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm;

/**
 * Turn a value into template text.
 *
 * Arrays become lines rather than `a,b,c`: every list in these templates —
 * steps, owned files, open questions — reads as lines, and Array#toString
 * would quietly produce the wrong shape in an artefact nobody re-reads.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (Array.isArray(value)) return value.map(stringify).join('\n');
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * The GitHub login of whoever is running this, or null.
 *
 * Two sources, in this order and for a reason. `repo.fork` was written by
 * `pdkit init` from the `origin` remote of the clone you were standing in, so
 * it is already the answer, costs nothing, and works offline. `gh api user` is
 * the fallback for a configuration filled in by hand, where the fork slug may
 * name an organisation rather than a person.
 *
 * Null is a legitimate answer and not an error: a body still says it was
 * prepared with the plugin, it just stops short of naming a human. The reverse
 * — inventing a name so a sentence comes out whole — would put an attribution
 * in front of an upstream reviewer that nobody stands behind.
 *
 * @param {{repoRoot?: string, home?: string, exec?: Function}} [options]
 * @returns {Promise<string|null>}
 */
export async function githubLogin(options = {}) {
  try {
    const fork = get(await load(options), 'repo.fork');
    const owner = typeof fork === 'string' ? fork.split('/')[0]?.trim() : '';
    if (owner) return owner;
  } catch {
    // A config that will not load is a problem the caller already has, and one
    // this function is not the place to report.
  }

  try {
    const login = (await gh(['api', 'user', '--jq', '.login'], { exec: options.exec })).trim();
    if (login) return login;
  } catch {
    // Not authenticated, not installed, offline. All the same answer here.
  }

  return null;
}

/**
 * Values a caller never has to pass, resolved only when a template asks.
 *
 * The alternative — requiring every caller to supply them — puts the same
 * lookup in the skill, in the CLI and in whatever comes next, and the day one
 * of the three forgets is the day a pull request body carries a raw
 * `{{reviewedBy}}` into someone else's repository.
 */
const IMPLICIT = {
  /**
   * The attribution clause, whole, rather than the login on its own.
   *
   * It holds the punctuation because the clause is what varies: with a login
   * the footer reads `…(Claude Code Plugin), reviewed by @jdoe`, and without
   * one it has to read `…(Claude Code Plugin)` and stop. A placeholder holding
   * just the name cannot express the second, and would render a dangling `@`.
   *
   * @param {{repoRoot?: string, home?: string}} [options]
   * @returns {Promise<string>}
   */
  reviewedBy: async (options) => {
    const login = await githubLogin(options);
    return login ? `, reviewed by @${login}` : '';
  },
};

/**
 * Render a template with the given values.
 *
 * Strict about leftovers. A `{{whereToLook}}` that survives into a PR body is
 * visible to a reviewer and reads as carelessness about their time, which is
 * the opposite of what the template is for — so an unfilled placeholder is an
 * error here rather than something to notice later.
 *
 * @param {keyof TEMPLATES} template
 * @param {Record<string, unknown>} values
 * @param {{stripComments?: boolean, repoRoot?: string, home?: string, exec?: Function}} [options]
 * @returns {Promise<string>}
 */
export async function render(template, values, options = {}) {
  const file = TEMPLATES[template];
  if (!file) throw new Error(`render: no template named "${template}"`);

  let text = await readFile(join(PLUGIN_ROOT, 'templates', file), 'utf8');

  // Resolved before the substitution pass, and only for a name the template
  // actually contains: a caller rendering a plan must not pay for a lookup the
  // PR body is the only artefact to need. An explicit value always wins — the
  // implicit one is a default, not an override.
  const asked = new Set([...text.matchAll(PLACEHOLDER)].map(([, name]) => name));
  const filled = { ...(values ?? {}) };
  for (const [name, resolve] of Object.entries(IMPLICIT)) {
    if (asked.has(name) && !(name in filled)) filled[name] = await resolve(options);
  }
  values = filled;

  const missing = new Set();
  text = text.replace(PLACEHOLDER, (match, name) => {
    if (!(name in (values ?? {}))) {
      missing.add(name);
      return match;
    }
    return stringify(values[name]);
  });

  if (missing.size > 0) {
    throw new Error(`render(${template}): nothing given for ${[...missing].map((n) => `{{${n}}}`).join(', ')}`);
  }

  // The guidance comments are written for whoever fills the template in. They
  // belong in a plan on disk and not in a pull request body, where they are
  // one "edit" click away from a reviewer reading our notes to ourselves.
  if (options.stripComments) text = text.replace(COMMENT, '');

  return text;
}

/**
 * Render and write an artefact into $PDKIT_HOME/issues/<n>/.
 *
 * `root` overrides that directory, and exists for the one artefact that is not
 * about an issue: a review of someone else's pull request lands in
 * $PDKIT_HOME/reviews/ because it belongs to no issue of ours (section 2.2).
 *
 * @param {{issue: number, template: keyof TEMPLATES, path: string, values: Record<string, unknown>, stripComments?: boolean, home?: string, repoRoot?: string, root?: string}} input
 * @returns {Promise<string>} the path written
 */
export async function write(input) {
  const text = await render(input.template, input.values, {
    stripComments: input.stripComments,
    home: input.home,
    repoRoot: input.repoRoot,
  });

  const target = join(input.root ?? issueDir(input.home ?? resolveHome(), input.issue), input.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);

  return target;
}

/** A markdown heading, one to three levels deep. */
const HEADING = /^(#{1,3})\s+(.+?)\s*$/gm;

/**
 * The headings a template declares, with placeholders resolved to nothing.
 *
 * `# PLAN: DESKTOP-{{issue}}` is a heading whose text varies per issue, so what
 * is compared is the part around the placeholder rather than the whole line.
 *
 * @param {string} text
 * @returns {Array<{level: number, text: string, pattern: RegExp}>}
 */
function headings(text) {
  const found = [];

  for (const [, hashes, heading] of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(HEADING)) {
    const pattern = new RegExp(
      `^${'#'.repeat(hashes.length)}\\s+${heading
        .split(/\{\{\s*[\w.]+\s*\}\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}\\s*$`,
      'm',
    );
    found.push({ level: hashes.length, text: heading, pattern });
  }

  return found;
}

/**
 * Check a rendered artefact still has every section its template declares.
 *
 * The case this catches is an agent rewriting a file and dropping a section —
 * which reads as an artefact that simply has less to say, rather than as
 * something missing. `Steps to check` absent from a PR body is not a shorter PR
 * body; it is the section a reviewer needs, gone.
 *
 * Extra sections are fine and are not reported. An artefact that says more than
 * the template asked for is not a defect, and treating it as one would push
 * whoever wrote it to say less.
 *
 * @param {keyof TEMPLATES} template
 * @param {string} content
 * @returns {Promise<{ok: boolean, missing: string[]}>}
 */
export async function validateSections(template, content) {
  const file = TEMPLATES[template];
  if (!file) throw new Error(`validateSections: no template named "${template}"`);

  const source = await readFile(join(PLUGIN_ROOT, 'templates', file), 'utf8');
  const text = String(content ?? '');

  const missing = headings(source)
    .filter((heading) => !heading.pattern.test(text))
    .map((heading) => heading.text);

  return { ok: missing.length === 0, missing };
}

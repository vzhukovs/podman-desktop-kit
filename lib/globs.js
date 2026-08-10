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

// Matching a repository-relative path against a pattern.
//
// Written because `Owns` in a plan is a list of paths and patterns, and the
// pre-write hook has to answer "is this file in that list" on every Write and
// Edit. The one piece of glob handling that already existed — expandPattern in
// lib/repo.js — cannot be reused: it expands a pattern against the filesystem
// to find directories, and it refuses `**` on purpose. Here nothing is read
// from disk and `**` is the common case.
//
// The contract is deliberately narrow, and the narrow parts are refusals rather
// than approximations. A pattern this module cannot express exactly is an
// error, because the alternative — matching almost what the plan said — decides
// whether a write is allowed.

/**
 * Escape a string for literal use inside a regular expression.
 *
 * Lives here rather than in lib/repo.js, which is where it started: two modules
 * build regular expressions out of path fragments now, and the copy that drifts
 * is the one nobody is looking at.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a path or pattern to the form used for comparison: forward
 * slashes, no leading `./`, no trailing slash except the one that marks a
 * directory pattern.
 *
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/** Compiled patterns, keyed by their source. Hooks run per tool call. */
const compiled = new Map();

/**
 * Compile a pattern into a regular expression anchored at both ends.
 *
 * Supported: `*` (within one segment), `?` (one character, not a separator),
 * `**` (whole segments), and a trailing `/` meaning "everything under this
 * directory". Everything else is literal.
 *
 * `**` must be a whole segment. `src/**.ts` is refused rather than read as
 * `src/*.ts`, because the two differ exactly where it matters — how deep the
 * permission reaches — and a plan that meant one and got the other would not
 * show the difference until a worker wrote somewhere it should not have.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function toRegExp(pattern) {
  const source = normalize(pattern);
  const cachedValue = compiled.get(source);
  if (cachedValue) return cachedValue;

  if (source === '') throw new Error('glob: empty pattern');

  // A trailing slash is the readable way to write "this directory and
  // everything in it", and plans are written by hand.
  const expanded = source.endsWith('/') ? `${source}**` : source;

  const segments = expanded.split('/');
  let body = '';

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;

    if (segment.includes('**')) {
      if (segment !== '**') {
        throw new Error(`glob: "**" must be a whole path segment in "${pattern}"`);
      }
      // A trailing `**` claims everything below, and requires something to be
      // there: `packages/main/**` covers packages/main/src/x.ts and does not
      // cover packages/main itself, which is a directory and not a file
      // anything writes to.
      body += last ? '[^/].*' : '(?:[^/]+/)*';
      continue;
    }

    body += segment
      .split(/([*?])/)
      .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeRegExp(part)))
      .join('');

    if (!last) body += '/';
  }

  const expression = new RegExp(`^${body}$`);
  compiled.set(source, expression);
  return expression;
}

/**
 * Whether a path matches one pattern.
 *
 * @param {string} path repository-relative
 * @param {string} pattern
 * @returns {boolean}
 */
export function matches(path, pattern) {
  return toRegExp(pattern).test(normalize(path));
}

/**
 * Whether a path matches any of the patterns. An empty list matches nothing —
 * a task that owns no files owns no files, and reading that as "owns
 * everything" is the failure mode worth being explicit about.
 *
 * @param {string} path repository-relative
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAny(path, patterns) {
  return (patterns ?? []).some((pattern) => matches(path, pattern));
}

/**
 * Which of the patterns the path matches. The hook reports the whole owned set
 * on a refusal, and the auditor needs to know which entry claimed a file.
 *
 * @param {string} path repository-relative
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function matching(path, patterns) {
  return (patterns ?? []).filter((pattern) => matches(path, pattern));
}

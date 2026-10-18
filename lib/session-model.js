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

// The model a fresh `claude` in the fork starts on.
//
// A skill's `model:` holds for one turn; after that the session's model runs
// the phase, and that model survives `/clear`. So the one place a default does
// any good is the session's starting point, and the one place for it that does
// not travel into upstream pull requests is the fork's settings.local.json —
// .claude/settings.json is podman-desktop's own file, tracked by git.
//
// Nothing here sets a model. The value is counted out of the skills'
// frontmatter, the only place CONTRIBUTING.md allows one, and `pdkit doctor`
// compares the written copy against a fresh count so a re-routed skill cannot
// leave it behind unnoticed.

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PLUGIN_ROOT } from './config.js';

/** Relative to the fork's root. Never .claude/settings.json: git tracks that one. */
export const SETTINGS_FILE = join('.claude', 'settings.local.json');

/**
 * The frontmatter of a skill, or null when there is no file or no block.
 *
 * @param {string} name  skill directory under skills/
 * @param {string} [pluginRoot]
 * @returns {Promise<string|null>}
 */
async function frontmatterOf(name, pluginRoot = PLUGIN_ROOT) {
  let text;
  try {
    text = await readFile(join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null;
}

/**
 * The `model:` a skill declares in its frontmatter, or null.
 *
 * Not a second place the model is set: this reads the one there is, so that it
 * can be shown where a person can act on it. The frontmatter alone lasts only
 * until the skill's turn ends — any user message ends it, a background
 * subagent's hand-back included — and from then on the phase runs on the
 * session's model. `/model` is typed by a person, so the place to say it is the
 * line they read before the phase, not the skill, which already runs on the
 * session's model by the time it could say anything.
 *
 * A missing file or field is not an error: there is simply no line to print.
 *
 * @param {string} name  skill directory under skills/
 * @param {string} [pluginRoot]
 * @returns {Promise<string|null>}
 */
export async function skillModel(name, pluginRoot = PLUGIN_ROOT) {
  const frontmatter = await frontmatterOf(name, pluginRoot);
  return frontmatter?.match(/^model:[ \t]*["']?([\w.-]+)["']?[ \t]*$/m)?.[1] ?? null;
}

/**
 * The model most orchestrating skills declare, with the count behind it.
 *
 * Orchestrating means `disable-model-invocation: true`, the same line the
 * specification uses to tell them from the phrase-triggered knowledge skills,
 * which carry no model at all. A tie gives null: neither side is "the" default
 * then, and writing one would be choosing it here instead of in frontmatter.
 *
 * @param {string} [pluginRoot]
 * @returns {Promise<{model: string|null, counts: Record<string, number>}>}
 */
export async function sessionModel(pluginRoot = PLUGIN_ROOT) {
  let names = [];
  try {
    names = (await readdir(join(pluginRoot, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { model: null, counts: {} };
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const name of names.sort()) {
    const frontmatter = await frontmatterOf(name, pluginRoot);
    if (!frontmatter || !/^disable-model-invocation:[ \t]*true[ \t]*$/m.test(frontmatter)) continue;
    const model = await skillModel(name, pluginRoot);
    if (model) counts[model] = (counts[model] ?? 0) + 1;
  }

  const ranked = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  return { model: ranked.length === 0 || tied ? null : ranked[0][0], counts };
}

/**
 * The fork's settings.local.json, parsed.
 *
 * Invalid JSON is its own answer rather than an empty object: the file holds
 * the person's permission rules, and treating it as blank is how they would be
 * overwritten.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ok: true, path: string, exists: boolean, text: string, settings: Record<string, unknown>} | {ok: false, path: string, error: string}>}
 */
export async function readSettings(repoRoot) {
  const path = join(repoRoot, SETTINGS_FILE);

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, path, exists: false, text: '', settings: {} };
    return { ok: false, path, error: `cannot read ${path} (${error.code ?? error.message})` };
  }

  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    return { ok: false, path, error: `${path} is not valid JSON (${error.message})` };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, path, error: `${path} does not hold a JSON object` };
  }

  return { ok: true, path, exists: true, text, settings };
}

/**
 * The indentation the file already uses, so a rewrite does not reflow it.
 *
 * @param {string} text
 * @returns {string|number}
 */
function indentOf(text) {
  return text.match(/^[{[][^\n]*\n([ \t]+)\S/)?.[1] ?? 2;
}

/**
 * Add `model` to the fork's settings.local.json, keeping everything else.
 *
 * A key already there is left alone unless `force`: somebody may have put it
 * there on purpose, and init is not the place to overrule them.
 *
 * @param {{repoRoot: string, model: string, force?: boolean}} input
 * @returns {Promise<{ok: true, path: string, model: string, action: 'created'|'added'|'kept'|'replaced', previous: unknown} | {ok: false, path: string, error: string}>}
 */
export async function writeModel(input) {
  const read = await readSettings(input.repoRoot);
  if (!read.ok) return read;

  const previous = read.settings.model;
  if (previous !== undefined && (!input.force || previous === input.model)) {
    return { ok: true, path: read.path, model: input.model, action: 'kept', previous };
  }

  const settings = { ...read.settings, model: input.model };
  const newline = read.exists && !read.text.endsWith('\n') ? '' : '\n';
  await mkdir(dirname(read.path), { recursive: true });
  await writeFile(read.path, `${JSON.stringify(settings, null, indentOf(read.text))}${newline}`);

  return {
    ok: true,
    path: read.path,
    model: input.model,
    action: !read.exists ? 'created' : previous === undefined ? 'added' : 'replaced',
    previous: previous ?? null,
  };
}

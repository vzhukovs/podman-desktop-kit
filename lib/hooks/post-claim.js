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

// PostToolUse handler for Write and Edit: a name written down as missing.
//
// A name borrowed from another project matches nothing here, because nothing
// here had a reason to use it. Read as "the concept is absent", that zero
// becomes a proposal to add what already exists under the local name. The
// search that produced the zero is not the moment to catch it: zeros are
// ordinary while exploring, and a real absence looks exactly the same. The
// moment is when the absence is written into a document as a claim.
//
// So this looks at markdown just written, finds sentences that propose adding
// a backticked name or say it is missing, and asks git whether the name
// occurs anywhere in podman-desktop outside the file being written. A name
// that does occur is not reported: the claim may still be wrong, but not in
// this way. A name that does not is reported with what to search instead.
//
// It never blocks and never decides the claim is false. A genuinely new API
// matches nothing too; the reminder is that a zero for a name is not yet
// evidence about the concept.
//
// Scoped to podman-desktop: the search needs the codebase the claim is about,
// and only that one is known. The document itself may live anywhere.

import { dirname, isAbsolute, relative } from 'node:path';

import { load } from '../config.js';
import * as git from '../git.js';
import { resolveRepoRoot } from '../repo.js';

/**
 * Output cap for the one search. Every occurrence of every name is printed,
 * and a common leaf (`fragment`) occurs thousands of times in podman-desktop.
 */
const SEARCH_BUFFER = 64 * 1024 * 1024;

/** Shorter leaves (`id`, `env`) match everything and say nothing. */
const MIN_LEAF = 4;

/** `env.uriScheme`, `registerUriHandler()`, `Foo.bar` — code names, not paths or commands. */
const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

/*
 * ABSENCE says a thing is not there. PROPOSAL says to add one, which claims
 * absence only for a member of something that exists: "add `env.uriScheme`"
 * says the `env` namespace lacks it, while "add a `DeepLinkDispatcher`" names
 * new code, and planning documents are full of those. Counting proposals of
 * bare names fired on 15 of 37 markdown writes in the sessions this was
 * measured on; counting them only for dotted names leaves the reminders that
 * are about an existing API.
 */
const ABSENCE = [
  /\b(?:missing|lacks?|lacking|absent|has no|there is no|no such)\b/i,
  /\b(?:does(?:n't| not)|do(?:n't| not)) (?:exist|have|expose|provide|support)\b/i,
  /\b(?:is|are)(?:n't| not) (?:exposed|available|supported|present|implemented|there)\b/i,
];
const PROPOSAL = [
  /\b(?:add|adds|adding|added|introduce[sd]?|introducing|new|expose[sd]?|exposing)\b/i,
];

const any = (patterns, sentence) => patterns.some((pattern) => pattern.test(sentence));

/**
 * Backticked names in sentences that propose them or say they are missing.
 *
 * @param {string} text
 * @returns {{name: string, leaf: string, sentence: string}[]}
 */
export function claims(text) {
  const found = [];
  const seen = new Set();
  for (const sentence of String(text).split(/\n|(?<=[.!?;])\s+/)) {
    const absence = any(ABSENCE, sentence);
    const proposal = any(PROPOSAL, sentence);
    if (!absence && !proposal) continue;
    for (const match of sentence.matchAll(/`([^`\n]+)`/g)) {
      const name = match[1].trim();
      if (!NAME.test(name)) continue;
      if (!absence && !name.replace(/\(\)$/, '').includes('.')) continue;
      const leaf = name.replace(/\(\)$/, '').split('.').pop();
      if (leaf.length < MIN_LEAF || seen.has(leaf)) continue;
      seen.add(leaf);
      found.push({ name, leaf, sentence: sentence.trim() });
    }
  }
  return found;
}

/**
 * The podman-desktop checkout the claim is about: the session's directory
 * first, where the work is, then the document's own.
 *
 * @param {string|undefined} cwd
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function targetRepo(cwd, filePath) {
  const config = await load({});
  for (const start of [cwd, dirname(filePath)]) {
    if (!start) continue;
    const repo = await resolveRepoRoot({ cwd: start, config });
    if (repo.root && repo.matches) return repo.root;
  }
  return null;
}

/**
 * Which of the leaves occur as whole words in the tracked files, the written
 * one aside. One git process for all of them, and no cap on how many: the
 * first version searched the first five, and the name it exists for was the
 * sixth in the document it exists for.
 *
 * Null when git could not answer. An exit of 1 with no output is "no match";
 * anything else is not knowing, and not knowing is not a zero.
 *
 * @param {string[]} leaves
 * @param {string} root
 * @param {string|null} exclude  path of the written file, relative to root
 * @param {{exec?: Function}} [options]
 * @returns {Promise<Set<string>|null>}
 */
export async function occurring(leaves, root, exclude, options = {}) {
  const args = ['grep', '-h', '-o', '-I', '-F', '-w', ...leaves.flatMap((leaf) => ['-e', leaf]), '--', '.'];
  if (exclude) args.push(`:(exclude)${exclude}`);
  const outcome = await git.result(args, { cwd: root, exec: options.exec, maxBuffer: SEARCH_BUFFER });
  if (outcome.ok) return new Set(outcome.stdout.split('\n').filter(Boolean));
  if (outcome.stdout === '' && outcome.stderr === '') return new Set();
  return null;
}

/**
 * Remind, when a written claim names something with no match in the codebase.
 *
 * @param {{tool_name?: string, cwd?: string, tool_input?: {file_path?: string, content?: string, new_string?: string}}|null} payload
 * @param {{event: string, pluginRoot: string, exec?: Function, findRepo?: typeof targetRepo}} context
 *   `exec` and `findRepo` are test seams; the host passes neither
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, context) {
  const filePath = payload?.tool_input?.file_path;
  if (!filePath || !filePath.endsWith('.md')) return { block: false };

  const written = payload.tool_input.content ?? payload.tool_input.new_string ?? '';
  const named = claims(written);
  if (named.length === 0) return { block: false };

  let root;
  try {
    root = await (context?.findRepo ?? targetRepo)(payload?.cwd, filePath);
  } catch {
    return { block: false };
  }
  if (!root) return { block: false };

  const inside = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  const exclude = inside && !inside.startsWith('..') ? inside : null;

  const found = await occurring(
    named.map((claim) => claim.leaf),
    root,
    exclude,
    { exec: context?.exec },
  );
  if (!found) return { block: false };
  const unmatched = named.filter((claim) => !found.has(claim.leaf));
  if (unmatched.length === 0) return { block: false };

  const rule = `${context?.pluginRoot ?? '${CLAUDE_PLUGIN_ROOT}'}/knowledge/pitfalls.md`;
  const list = unmatched.map((claim) => `\`${claim.name}\``).join(', ');
  return {
    block: false,
    rule: 'name-claim',
    message:
      `pdkit: this text proposes or calls missing ${list}, and ${unmatched.length === 1 ? 'that name matches' : 'those names match'} ` +
      `nothing in podman-desktop outside this file. A name with no match is not yet evidence that the ` +
      `concept is absent. If the name comes from another project, find what it is built from there and ` +
      `search for that here; search the API declarations for the concept as well, case-insensitive, with ` +
      `no window and not as one alternative among others. Keep the claim only if both come back empty. ` +
      `See "A name from another project" in ${rule}.`,
  };
}

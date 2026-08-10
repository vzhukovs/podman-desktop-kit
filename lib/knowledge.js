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

// Revision of the shipped knowledge base (spec section 4, /pd:knowledge).
//
// knowledge/ ships with the plugin and is read by every later issue, which
// makes it the one place where being quietly wrong is expensive: nobody
// re-derives what a file states as settled. And "re-read four files" is not a
// revision — it is reading, with the same model that would have to notice its
// own earlier mistake.
//
// So the same split as plan-review and audit (decision 18). What a grep can
// answer, a grep answers: a path that no longer exists, a layer list that has
// drifted from the generated map, an entry that does not follow the shape its
// own file declares. What is left for the model is the part that has no
// mechanical form — an entry that was never true, a lesson worth stating
// differently, a finding that would change nothing on a future run and is
// therefore not knowledge.
//
// Nothing here decides, and nothing here writes to knowledge/. Additions are
// the user's to approve (see skills/close), because a knowledge base that grows
// on its own is a knowledge base nobody reads.

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PLUGIN_ROOT, get, resolveHome } from './config.js';
import { read as readJournal } from './journal.js';
import { readPackageMap } from './repo.js';

/** Where the base lives, inside the plugin. */
export const KNOWLEDGE_DIR = join(PLUGIN_ROOT, 'knowledge');

/** A path or a `path:line` mentioned in backticks. */
const REFERENCE = /`([a-zA-Z0-9_.@/-]+\.[a-zA-Z0-9]+(?::\d+)?)`/g;


/** Paths that are ours, not the fork's, and so are not checked against it. */
const OURS = /^(pdkit|knowledge|templates|skills|agents|specs|defaults|lib|test|bin|docs)\//;

/** A layer chain, as package-map.md writes it. */
const CHAIN = /^([a-z@/*+-]+(?:\s*→\s*[a-zA-Z@/*, +-]+)+)$/m;

/** The section every file ends with, declaring what may be added to it. */
const ADMISSION = '## What to add here';

/** The shape pitfalls.md declares for its own entries. */
const PITFALL_FIELDS = ['Looks like:', 'Actually:', 'Why it matters:', 'Caught by:'];

/** Journal events worth proposing as knowledge. */
const NOTABLE = new Set(['conflict-semantic', 'slice-regressed', 'slice-verify-failed', 'slice-verify-inconclusive', 'pr-closed']);

/**
 * @typedef {object} Finding
 * @property {string} file
 * @property {string} kind      dead-reference | layer-drift | entry-shape | admission
 * @property {string} detail
 */

/**
 * Read the base.
 *
 * @param {{dir?: string}} [options]
 * @returns {Promise<Array<{name: string, path: string, text: string}>>}
 */
export async function files(options = {}) {
  const dir = options.dir ?? KNOWLEDGE_DIR;
  const names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();

  return Promise.all(
    names.map(async (name) => ({ name, path: join(dir, name), text: await readFile(join(dir, name), 'utf8') })),
  );
}

/**
 * Paths a file claims exist in the fork, and whether they still do.
 *
 * A reference to a file that is gone is "an entry that is now wrong", literally
 * and mechanically. It is also the most common way for this base to rot: code
 * moves, and prose does not follow.
 *
 * @param {{text: string, repoRoot: string|null}} input
 * @returns {Promise<Array<{reference: string, path: string, line: number|null, exists: boolean, longEnough: boolean}>>}
 */
export async function references(input) {
  if (!input.repoRoot) return [];

  const seen = new Map();

  for (const match of String(input.text ?? '').matchAll(REFERENCE)) {
    const reference = match[1];
    // A bare filename is a name, not a location: prose says `extension-api.d.ts`
    // meaning "that file", and resolving it against the repository root would
    // report a dead reference for something that is merely being named.
    if (!reference.includes('/') || OURS.test(reference) || seen.has(reference)) continue;

    const [path, rawLine] = reference.split(':');
    const line = rawLine ? Number(rawLine) : null;

    let exists = true;
    let longEnough = true;
    try {
      await access(join(input.repoRoot, path));
      if (line !== null) {
        const contents = await readFile(join(input.repoRoot, path), "utf8");
        longEnough = contents.split('\n').length >= line;
      }
    } catch {
      exists = false;
      longEnough = false;
    }

    seen.set(reference, { reference, path, line, exists, longEnough });
  }

  return [...seen.values()];
}

/**
 * The layer chain package-map.md states, as a list.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function layerChain(text) {
  const fenced = /```[\s\S]*?```/g;
  for (const block of String(text ?? '').match(fenced) ?? []) {
    const match = CHAIN.exec(block.replace(/```/g, '').trim());
    if (!match) continue;

    return match[1]
      .split('→')
      // "renderer + ui" and "renderer, ui" both mean two layers that merge
      // together, and the chain is read for which layers exist rather than for
      // how the prose groups them.
      .flatMap((part) => part.split(/[,+]/))
      .map((part) => part.trim().replace(/\/\*$/, '').replace(/\/docs$/, ''))
      .filter(Boolean);
  }

  return [];
}

/**
 * Everything mechanical about the current state of the base.
 *
 * @param {{repoRoot?: string|null, config?: object, home?: string, dir?: string}} input
 * @returns {Promise<{files: Array<{name: string, bytes: number, sections: number}>, findings: Finding[], candidates: Array<{issue: number, events: Array<{event: string, at: string, detail: string}>}>}>}
 */
export async function collect(input = {}) {
  const home = input.home ?? resolveHome({ repoRoot: input.repoRoot ?? undefined });
  const config = input.config ?? {};
  const entries = await files({ dir: input.dir });

  /** @type {Finding[]} */
  const findings = [];

  for (const entry of entries) {
    for (const reference of await references({ text: entry.text, repoRoot: input.repoRoot ?? null })) {
      if (!reference.exists) {
        findings.push({ file: entry.name, kind: 'dead-reference', detail: `${reference.reference} is not in the fork any more` });
      } else if (!reference.longEnough) {
        findings.push({
          file: entry.name,
          kind: 'dead-reference',
          detail: `${reference.reference} points past the end of the file, so the line it cites has moved`,
        });
      }
    }

    if (!entry.text.includes(ADMISSION)) {
      findings.push({
        file: entry.name,
        kind: 'admission',
        detail: `no "${ADMISSION}" section, so nothing states what belongs in this file`,
      });
    }

    if (entry.name === 'pitfalls.md') {
      for (const section of sectionsOf(entry.text)) {
        const missing = PITFALL_FIELDS.filter((field) => !section.body.includes(`**${field}`));
        if (missing.length > 0) {
          findings.push({
            file: entry.name,
            kind: 'entry-shape',
            detail: `"${section.title}" is missing ${missing.join(', ')}`,
          });
        }
      }
    }

    if (entry.name === 'package-map.md') {
      const stated = layerChain(entry.text);
      const configured = (get(config, 'slicing.layer_order') ?? []).map(String);

      let generated = [];
      try {
        generated = (await readPackageMap({ home })).layers ?? [];
      } catch {
        // No map yet. The config comparison below is still worth making.
      }

      const missing = configured.filter((layer) => !stated.includes(layer));
      if (configured.length > 0 && missing.length > 0) {
        findings.push({
          file: entry.name,
          kind: 'layer-drift',
          detail: `slicing.layer_order has ${missing.join(', ')}, and the chain stated here does not`,
        });
      }

      const unknown = stated.filter((layer) => configured.length > 0 && !configured.includes(layer));
      if (unknown.length > 0) {
        findings.push({
          file: entry.name,
          kind: 'layer-drift',
          detail: `the chain names ${unknown.join(', ')}, which slicing.layer_order does not`,
        });
      }

      const ungrouped = generated.filter((layer) => layer !== 'other' && !stated.includes(layer));
      if (ungrouped.length > 0) {
        findings.push({
          file: entry.name,
          kind: 'layer-drift',
          detail: `package-map.json has ${ungrouped.join(', ')}, and the chain stated here does not`,
        });
      }
    }
  }

  return {
    files: entries.map((entry) => ({
      name: entry.name,
      bytes: Buffer.byteLength(entry.text),
      sections: sectionsOf(entry.text).length,
    })),
    findings,
    candidates: await candidates({ home }),
  };
}

/**
 * `## ` sections of a document, with their bodies.
 *
 * @param {string} text
 * @returns {Array<{title: string, body: string}>}
 */
function sectionsOf(text) {
  const sections = [];
  let current = null;

  for (const line of String(text ?? '').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }

  if (current) sections.push(current);
  return sections.filter((section) => section.title !== ADMISSION.replace('## ', ''));
}

/**
 * Issues whose journal recorded something a future run would want to know.
 *
 * Candidates, not knowledge. What makes an entry worth keeping is whether it
 * would change what a later issue does, and no event name answers that.
 *
 * @param {{home: string}} input
 * @returns {Promise<Array<{issue: number, events: Array<{event: string, at: string, detail: string}>}>>}
 */
async function candidates(input) {
  let entries = [];
  try {
    entries = await readJournal({}, { home: input.home });
  } catch {
    return [];
  }

  /** @type {Map<number, Array<{event: string, at: string, detail: string}>>} */
  const byIssue = new Map();
  for (const entry of entries) {
    if (!NOTABLE.has(entry.event) || !entry.issue) continue;
    byIssue.set(entry.issue, [...(byIssue.get(entry.issue) ?? []), { event: entry.event, at: entry.at, detail: entry.detail ?? '' }]);
  }

  return [...byIssue.entries()]
    .map(([issue, events]) => ({ issue, events }))
    .sort((left, right) => right.issue - left.issue);
}

/**
 * The base, in a form that can be pushed to an external store.
 *
 * One direction only (section 8). The source of truth is these files: an import
 * path would produce a second one, and a plugin whose knowledge lives somewhere
 * else stops being portable to whoever installs it next.
 *
 * pdkit does not do the pushing. It has no MCP client, and giving it one to
 * write into a personal note store would put a network write behind a command
 * whose whole job is reading local files.
 *
 * @param {{dir?: string}} [options]
 * @returns {Promise<Array<{name: string, title: string, sections: string[], text: string}>>}
 */
export async function exportEntries(options = {}) {
  const entries = await files(options);

  return entries.map((entry) => ({
    name: entry.name,
    title: (/^#\s+(.+)$/m.exec(entry.text)?.[1] ?? entry.name).trim(),
    sections: sectionsOf(entry.text).map((section) => section.title),
    text: entry.text,
  }));
}

/**
 * Render a report for a terminal.
 *
 * @param {Awaited<ReturnType<typeof collect>>} report
 * @returns {string}
 */
export function format(report) {
  const lines = ['knowledge:'];

  for (const file of report.files) {
    lines.push(`  ${file.name.padEnd(24)} ${String(file.sections).padStart(2)} entries, ${file.bytes} bytes`);
  }

  lines.push('');
  if (report.findings.length === 0) {
    lines.push('  Nothing mechanical to fix.');
  } else {
    lines.push(`  ${report.findings.length} mechanical finding(s):`);
    for (const finding of report.findings) lines.push(`    ✘ ${finding.file} [${finding.kind}] ${finding.detail}`);
  }

  if (report.candidates.length > 0) {
    lines.push('', '  Issues whose journal recorded something notable:');
    for (const candidate of report.candidates.slice(0, 10)) {
      lines.push(`    #${candidate.issue}: ${candidate.events.map((event) => event.event).join(', ')}`);
    }
  }

  lines.push(
    '',
    '  These are facts, not a revision. What is left is what no grep answers:',
    '  an entry that was never true, a lesson worth stating differently, and a',
    '  finding that would change nothing on a future run — which is not knowledge.',
    '',
  );

  return lines.join('\n');
}

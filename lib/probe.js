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

// Running each task's `Done when` before any code exists, and keeping what it
// printed.
//
// `plan check` has always refused a `Done when` that is prose. It never asked
// whether the command runs. A plan went through four review rounds and was
// approved; then five of its tasks stopped during exec on commands that could
// never pass — a typecheck that fails on the base branch with a config error, a
// lint that fails on two lines the task may not touch, a docs build that needs
// an artefact nothing builds, a typecheck the task had not been given at all.
// Every one of them was visible by running the command on the base commit, and
// nobody had: the critic reads, and does not run.
//
// So the run is a record, `probe.json` under the issue, one entry per task: the
// command, the commit and whether the tree was clean, the exit code, and the
// tail of the output. A failure before the code exists is usually expected —
// the spec file is not there yet — and telling that from a broken command is
// judgment: the record goes to the reviewer, and nothing here grades it.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import * as evidence from './evidence.js';
import * as git from './git.js';

/** Lines of output kept per run: enough to show the error, not the whole log. */
export const TAIL_LINES = 20;

/**
 * One run of one task's `Done when`.
 *
 * @typedef {object} ProbeRun
 * @property {string} task
 * @property {string} command
 * @property {number|null} exitCode   null when the run was killed
 * @property {boolean} complete
 * @property {string} [incompleteBecause]
 * @property {number} durationMs
 * @property {string} at
 * @property {string|null} head       the commit it ran on
 * @property {boolean|null} dirty     tracked changes in the tree, null when git could not say
 * @property {string[]} tail          the last lines it printed
 */

/**
 * The runs recorded for an issue, by task. Empty when nothing was probed.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Record<string, ProbeRun>>}
 */
export async function read(issue, options = {}) {
  const path = join(issueDir(options.home ?? resolveHome(), issue), 'probe.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed.runs === 'object' && parsed.runs !== null ? parsed.runs : {};
  } catch {
    return {};
  }
}

/**
 * Run the given tasks' commands in a tree and record what each one did.
 *
 * One at a time, in the order given: these are builds and test suites, and two
 * of them in one tree at once measure each other.
 *
 * @param {{
 *   issue: number,
 *   cwd: string,
 *   tasks: Array<{id: string, command: string}>,
 *   home?: string,
 *   capture?: typeof evidence.capture,
 *   gitOptions?: object,
 *   onRun?: (run: ProbeRun) => void,
 * }} input
 * @returns {Promise<ProbeRun[]>}
 */
export async function run(input) {
  const home = input.home ?? resolveHome();
  const capture = input.capture ?? evidence.capture;
  const head = await git.trimmedOrNull(['rev-parse', '--short', 'HEAD'], { cwd: input.cwd, ...(input.gitOptions ?? {}) });
  const status = await git.trimmedResult(['status', '--porcelain', '--untracked-files=no'], { cwd: input.cwd, ...(input.gitOptions ?? {}) }).catch(() => null);
  const dirty = status && status.ok ? status.stdout !== '' : null;

  const runs = [];
  for (const task of input.tasks) {
    const captured = await capture({ command: task.command, cwd: input.cwd });
    const lines = `${captured.stdout ?? ''}${captured.stderr ?? ''}`.split('\n').filter((line) => line.trim() !== '');
    /** @type {ProbeRun} */
    const entry = {
      task: task.id,
      command: task.command,
      exitCode: captured.exitCode,
      complete: captured.complete,
      ...(captured.incompleteBecause ? { incompleteBecause: captured.incompleteBecause } : {}),
      durationMs: captured.durationMs,
      at: captured.at,
      head,
      dirty,
      tail: lines.slice(-TAIL_LINES),
    };
    runs.push(entry);
    // Written after every run, not at the end: an e2e command can take most of
    // an hour, and a probe interrupted at the fourth task should keep three.
    await record(input.issue, [entry], home);
    input.onRun?.(entry);
  }
  return runs;
}

/**
 * Merge runs into probe.json, the newest per task.
 *
 * @param {number} issue
 * @param {ProbeRun[]} runs
 * @param {string} home
 * @returns {Promise<void>}
 */
async function record(issue, runs, home) {
  const existing = await read(issue, { home });
  for (const entry of runs) existing[entry.task] = entry;
  await writeFile(join(issueDir(home, issue), 'probe.json'), `${JSON.stringify({ runs: existing }, null, 2)}\n`);
}

/**
 * What the probe record says about a plan's live tasks, as plan-check warnings.
 *
 * Warnings, not problems: a red run before the code exists is the normal case
 * for a test of a file nobody has written, and calling it a defect would train
 * everyone to skip the line. What is reported is what was measured — never run,
 * run with a different command than the plan now has, ran on a dirty tree, or
 * exited non-zero, with the last line it printed — and the reviewer decides.
 *
 * @param {Array<{id: string, command: string|null}>} live
 * @param {Record<string, ProbeRun>} runs
 * @returns {Array<{check: string, detail: string}>}
 */
export function warningsFor(live, runs) {
  const warnings = [];
  for (const task of live) {
    if (!task.command) continue;
    const seen = runs[task.id];
    if (!seen) {
      warnings.push({ check: 'done-when-run', detail: `${task.id}'s Done when has never been run — \`pdkit plan probe\` runs it on the base commit` });
      continue;
    }
    if (seen.command !== task.command) {
      warnings.push({ check: 'done-when-run', detail: `${task.id}'s Done when changed since it was run; the run on record is of \`${seen.command}\`` });
      continue;
    }
    const where = `${seen.head ?? 'an unknown commit'}${seen.dirty ? ', tree with changes' : ''}`;
    if (!seen.complete) {
      warnings.push({ check: 'done-when-run', detail: `${task.id}'s Done when did not finish on ${where}: ${seen.incompleteBecause ?? 'incomplete'}` });
    } else if (seen.exitCode !== 0) {
      const last = seen.tail[seen.tail.length - 1] ?? '(no output)';
      warnings.push({ check: 'done-when-run', detail: `${task.id}'s Done when exited ${seen.exitCode ?? 'none'} on ${where} — last line: ${last.slice(0, 160)}` });
    }
  }
  return warnings;
}

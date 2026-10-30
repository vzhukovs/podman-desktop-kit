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

// Running the scripts lib/scripts.js resolves, on preflight's behalf: why a run
// could not start, and whether slice verify already measured it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { get, issueDir } from '../config.js';
import { capture, validateReceipt } from '../evidence.js';

export { candidatesFor, runScript, scopedScripts, typecheckScripts } from '../scripts.js';

/**
 * Why a script could not be started, or null when it ran — whatever it said.
 *
 * A shell that cannot find a command exits 127, and that is a fact about PATH,
 * not about the code. cmd.exe is the exception: under `cmd /d /s /c` it exits 1
 * and says `'x' is not recognized as an internal or external command`, so on
 * Windows the sentence is the signal, not the code. On DESKTOP-19901 a node upgrade left
 * `pnpm` off PATH, and tests, lint and typecheck all came back `failing` with
 * "fix the tests, or the code they are telling you about" — the remedy for a
 * different problem, followed for five minutes before anyone read the output.
 *
 * @param {import('../evidence.js').Capture} result
 * @param {import('./index.js').PreflightContext} context
 * @returns {string|null}
 */
export function unrunnable(result, context) {
  const said = `${result.stderr}\n${result.stdout}`;
  const cmd = /^'([^']+)' is not recognized as an internal or external command/m.exec(said);
  const notFound = result.exitCode === 127 || result.exitCode === 9009 || (result.exitCode !== 0 && result.exitCode !== null && cmd !== null);
  if (!notFound) return null;

  const manager = get(context.config, 'repo.package_manager') ?? 'pnpm';
  // The manager itself, or something a script calls. Both are the environment;
  // only the remedy differs.
  const named = cmd?.[1] ?? /([\w.@/-]+): (?:command )?not found/.exec(said)?.[1] ?? null;
  const missing = named === manager || new RegExp(`(^|[\\s:])${manager}: (command )?not found`, 'm').test(said) ? manager : named;

  return missing === manager
    ? `${manager} is not on PATH`
    : `${missing ? `\`${missing}\`` : 'a command it calls'} is not on PATH (exit ${result.exitCode})`;
}

/**
 * The result for a check whose scripts could not be started.
 *
 * Still a blocking `fail` — nothing was measured, and a gate that passes on an
 * unmeasured run is the thing this file exists to prevent — but worded as the
 * environment it is.
 *
 * @param {string} id
 * @param {boolean} blocking
 * @param {string[]} reasons  one per script, from `unrunnable`
 * @param {string} output
 * @param {import('./index.js').PreflightContext} context
 * @returns {import('./index.js').CheckResult}
 */
export function environmentFailure(id, blocking, reasons, output, context) {
  const manager = get(context.config, 'repo.package_manager') ?? 'pnpm';
  return {
    id,
    status: 'fail',
    blocking,
    summary: `could not run: ${[...new Set(reasons)].join('; ')} — the environment, not the code`,
    output,
    remedy: `put ${manager} on PATH (\`pdkit doctor\` checks it) or run \`${manager} install\` for a missing dependency binary, then run preflight again`,
  };
}

/** One lookup per preflight run, shared by the three checks that ask. */
const verifiedRuns = new WeakMap();

/**
 * The slice verification's run, when it already ran these scripts on this commit.
 *
 * `slice verify` runs typecheck, lint and the scoped tests on the slice's
 * commit, and preflight used to run the same three again straight after it: on
 * DESKTOP-19818 the pair outlived a 600-second tool timeout. When the receipt
 * validates, exited 0, names this exact commit and the tree has no tracked
 * change, running them again measures nothing new — the same commit, the same
 * scripts. Anything short of all of that and the scripts run as before.
 *
 * @param {import('./index.js').PreflightContext} context
 * @returns {Promise<{command: string, commit: string, at: string|null, evidence: string}|null>}
 */
export function verifiedRun(context) {
  if (!verifiedRuns.has(context)) verifiedRuns.set(context, findVerifiedRun(context));
  return verifiedRuns.get(context);
}

/**
 * @param {import('./index.js').PreflightContext} context
 * @returns {Promise<{command: string, commit: string, at: string|null, evidence: string}|null>}
 */
async function findVerifiedRun(context) {
  const path = context.sliceRecord?.verification?.evidence;
  if (!path || !context.headSha || !context.home) return null;

  let content;
  try {
    content = await readFile(join(issueDir(context.home, context.issue), path), 'utf8');
  } catch {
    return null;
  }

  const checked = validateReceipt(content);
  if (!checked.ok || checked.exitCode !== 0) return null;

  const commit = /^- Commit: ([0-9a-f]{7,40})\s*$/m.exec(content)?.[1] ?? null;
  if (!commit || !context.headSha.startsWith(commit)) return null;

  // The commit says what was verified; the scripts run the working tree. They
  // agree only when nothing tracked has changed since.
  const status = await capture({ command: 'git status --porcelain', cwd: context.repoRoot });
  if (status.exitCode !== 0 || status.stdout.split('\n').some((line) => line.trim() !== '' && !line.startsWith('??'))) return null;

  const at = /^- Completed: (\S+)\s*$/m.exec(content)?.[1] ?? null;
  return { command: checked.command, commit, at, evidence: path };
}

/**
 * Whether a verified run covered every one of these scripts.
 *
 * Matched on `run <script>` rather than on the whole step, so the package
 * manager the receipt names does not have to be spelled as this run's config
 * spells it — the script is what was measured.
 *
 * @param {{command: string}} run
 * @param {string[]} names
 * @returns {boolean}
 */
export function covers(run, names) {
  const steps = run.command.split('&&').map((step) => step.trim());
  return names.length > 0 && names.every((name) => steps.some((step) => step.endsWith(` run ${name}`)));
}

/**
 * The pass of a check whose scripts the slice verification already ran.
 *
 * @param {string} id
 * @param {boolean} blocking
 * @param {string[]} names
 * @param {{commit: string, at: string|null, evidence: string}} run
 * @returns {import('./index.js').CheckResult}
 */
export function passedInVerify(id, blocking, names, run) {
  return {
    id,
    status: 'pass',
    blocking,
    summary: `${names.join(', ')} — passed in slice verify on ${run.commit.slice(0, 11)}${run.at ? ` at ${run.at}` : ''}, not run again`,
    output: `the run is ${run.evidence} under the issue`,
  };
}

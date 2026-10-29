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

// Working out which scripts to run for the packages a diff touches.
//
// Script names are resolved from the repository's own package.json (spec
// section 7) rather than baked in here. podman-desktop has no `pnpm lint`, its
// `pnpm test` drags in the e2e suite, and upstream renames scripts without
// warning — a hardcoded name that stops existing becomes a check that silently
// never runs, which is the worst outcome available to a gate.
//
// The mapping from a package to its script name is not derivable, and pretending
// otherwise is how this goes wrong: packages/api is `test:core-api`,
// packages/ui is `test:ui` while its package name is @podman-desktop/ui-svelte,
// and extensions/podman is `test:extensions:podman`. So several candidate names
// are tried per package and the first one the repository defines wins.

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { get, issueDir } from '../config.js';
import { capture, validateReceipt } from '../evidence.js';
import { packageFor, pickScript } from '../repo.js';

/**
 * Candidate script names for one package, most specific first.
 *
 * @param {string} verb                 "test" or "typecheck"
 * @param {{name: string, path: string}} entry
 * @returns {string[]}
 */
export function candidatesFor(verb, entry) {
  const directory = basename(entry.path);
  const unscoped = entry.name.includes('/') ? entry.name.split('/').pop() : entry.name;
  const area = entry.path.split('/')[0];

  return [
    `${verb}:${directory}`,
    `${verb}:${unscoped}`,
    // extensions/podman -> test:extensions:podman
    ...(area === 'extensions' ? [`${verb}:${area}:${directory}`] : []),
  ];
}

/**
 * Which of the repository's scripts a diff actually needs run.
 *
 * Scoped because running every package's tests to check a one-file change is
 * minutes spent on packages the diff never touched. `unresolved` and
 * `usedFallback` are reported rather than swallowed: a package with no script of
 * this kind was not checked, and a report that quietly ran something broader is
 * a report about a different question.
 *
 * @typedef {object} Scoped
 * @property {string[]} scripts       script names to run
 * @property {string[]} packages      packages the diff touches
 * @property {string[]} unresolved    packages with no script of this kind
 * @property {boolean} usedFallback
 */

/**
 * Scripts to run for the packages a diff touches.
 *
 * Falls back to the repository-wide script when the diff touches nothing the
 * package map claims, or when a touched package has no script of its own. The
 * fallback is deliberately not silent: `unresolved` names the packages it is
 * standing in for, so a package that quietly stopped being covered is visible
 * in the report rather than absorbed by a green tick.
 *
 * @param {import('./index.js').PreflightContext} context
 * @param {{verb: string, fallback: string[]}} options
 * @returns {Promise<Scoped>}
 */
export async function scopedScripts(context, options) {
  const map = context.packageMap;
  const touched = new Map();

  for (const file of context.changedFiles) {
    const owner = await packageFor(file, { map });
    if (owner) touched.set(owner.name, owner);
  }

  const scripts = new Set();
  const unresolved = [];

  for (const entry of touched.values()) {
    const found = pickScript(context.scripts, candidatesFor(options.verb, entry));
    if (found) scripts.add(found);
    else unresolved.push(entry.name);
  }

  let usedFallback = false;
  if (scripts.size === 0 || unresolved.length > 0) {
    const fallback = pickScript(context.scripts, options.fallback);
    if (fallback) {
      scripts.add(fallback);
      usedFallback = true;
    }
  }

  return {
    scripts: [...scripts],
    packages: [...touched.keys()],
    unresolved,
    usedFallback,
  };
}

/**
 * What typechecks a diff: the repository's whole `typecheck`, not the touched
 * packages' own.
 *
 * Scoping is right for tests and wrong for types, because a type error lands
 * in the package that CONSUMES the change rather than the one that makes it.
 * On DESKTOP-19818 slice #2 changed two signatures in packages/preload, ran
 * `typecheck:preload`, and was recorded green standalone, and preflight passed
 * it the same way. The renderer reads those signatures through
 * `exposedInMainWorld.d.ts`, and upstream CI's whole typecheck went red on the
 * pull request. Both gates answered for the package the diff was in, and
 * nobody had asked that question.
 *
 * `preflight.typecheck_scope: packages` restores the per-package scripts, for a
 * repository whose whole typecheck is too slow to pay on every slice. The
 * scoped answer is still reported as scoped, so nobody reads it as the whole one.
 *
 * @param {import('./index.js').PreflightContext} context
 * @returns {Promise<Scoped & {whole: boolean}>}
 */
export async function typecheckScripts(context) {
  const scoped = await scopedScripts(context, { verb: 'typecheck', fallback: ['typecheck'] });
  if (get(context.config, 'preflight.typecheck_scope') === 'packages') return { ...scoped, whole: false };

  const whole = pickScript(context.scripts, ['typecheck']);
  if (!whole) return { ...scoped, whole: false };

  return { scripts: [whole], packages: scoped.packages, unresolved: [], usedFallback: false, whole: true };
}

/**
 * The command that runs a script, per the configured package manager.
 *
 * @param {import('./index.js').PreflightContext} context
 * @param {string} script
 * @returns {string}
 */
export function runScript(context, script) {
  return `${get(context.config, 'repo.package_manager') ?? 'pnpm'} run ${script}`;
}

/**
 * Why a script could not be started, or null when it ran — whatever it said.
 *
 * A shell that cannot find a command exits 127 (9009 from cmd.exe), and that is
 * a fact about PATH, not about the code. On DESKTOP-19901 a node upgrade left
 * `pnpm` off PATH, and tests, lint and typecheck all came back `failing` with
 * "fix the tests, or the code they are telling you about" — the remedy for a
 * different problem, followed for five minutes before anyone read the output.
 *
 * @param {import('../evidence.js').Capture} result
 * @param {import('./index.js').PreflightContext} context
 * @returns {string|null}
 */
export function unrunnable(result, context) {
  const notFound = result.exitCode === 127 || result.exitCode === 9009;
  if (!notFound) return null;

  const manager = get(context.config, 'repo.package_manager') ?? 'pnpm';
  const said = `${result.stderr}\n${result.stdout}`;
  // The manager itself, or something a script calls. Both are the environment;
  // only the remedy differs.
  const missing = new RegExp(`(^|[\\s:'"])${manager}(: command not found|: not found|' is not recognized)`, 'm').test(said)
    ? manager
    : (/([\w.@/-]+): (?:command )?not found/.exec(said)?.[1] ?? null);

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

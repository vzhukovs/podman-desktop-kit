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

import { basename } from 'node:path';

import { get } from '../config.js';
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
 * The command that runs a script, per the configured package manager.
 *
 * @param {import('./index.js').PreflightContext} context
 * @param {string} script
 * @returns {string}
 */
export function runScript(context, script) {
  return `${get(context.config, 'repo.package_manager') ?? 'pnpm'} run ${script}`;
}

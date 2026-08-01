// SPDX-License-Identifier: Apache-2.0

// Preflight check: e2e environment
//
// A test that needs an environment CI does not have must say so in Notes for
// reviewers rather than quietly fail there.
//
// The patterns below are read off what podman-desktop's own specs already do:
// gate on TEST_PODMAN_MACHINE, branch on process.platform, carry a @k8s_e2e tag
// that the default e2e run excludes with --grep-invert. Each is a way of saying
// "this needs something the machine running it may not have", and a reviewer
// who is not told will read the green run as covering it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @type {string} */
export const id = 'e2e-environment';

/** @type {boolean} */
export const blocking = true;

/** Where e2e tests live in this repository. */
const E2E = /(^|\/)tests\/playwright\/.*\.spec\.[cm]?ts$/;

/** Ways a test says it needs something the runner may not have. */
const NEEDS = [
  { label: 'a container engine or machine', test: /TEST_PODMAN_MACHINE|MACHINE_CLEANUP|podman machine|docker\.sock/i },
  { label: 'a Kubernetes cluster', test: /@k8s_e2e|KIND_PROVIDER|SKIP_KIND_INSTALL|kubeconfig/i },
  { label: 'a specific platform', test: /process\.platform|isLinux|isWindows|isMac|win32|darwin/ },
  { label: 'a network service or registry', test: /canTestRegistry|registry\.|rate limit/i },
  { label: 'an environment variable', test: /test\.skip\(\s*(!{0,2})?process\.env\./ },
];

/** Where the answer belongs. Same section as ci-blind-spots, deliberately. */
const NOTES = /Notes for reviewers([\s\S]{20,})/i;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const specs = context.changed.filter((entry) => entry.status !== 'D' && E2E.test(entry.path)).map((entry) => entry.path);

  if (specs.length === 0) {
    return { id, status: 'pass', blocking, summary: 'no e2e test in this diff' };
  }

  /** @type {Record<string, string[]>} */
  const needs = {};

  for (const spec of specs) {
    let source;
    try {
      source = await readFile(join(context.repoRoot, spec), 'utf8');
    } catch {
      // Added in the diff but not on disk: a stale index, not a finding about
      // the environment. e2e-stability is where a missing spec is reported.
      continue;
    }

    for (const need of NEEDS) {
      if (need.test.test(source)) (needs[need.label] ??= []).push(spec);
    }
  }

  const areas = Object.keys(needs);
  if (areas.length === 0) {
    return { id, status: 'pass', blocking, summary: `${specs.length} e2e test(s), none needing anything special` };
  }

  const output = areas.map((area) => `${area}\n  ${needs[area].join('\n  ')}`).join('\n\n');

  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: `${areas.join(', ')} — the PR body is not drafted yet`,
      remedy: 'say in Notes for reviewers what the test needs and where it will not run, then run preflight again',
      output,
    };
  }

  if (!NOTES.test(context.prBody)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the e2e test needs ${areas.join(', ')}, and the body has no Notes for reviewers`,
      output,
      remedy: 'a test that quietly skips in CI looks like a test that passed. Say what it needs and who has to run it by hand',
    };
  }

  return { id, status: 'pass', blocking, summary: `${areas.join(', ')} — covered in Notes for reviewers` };
}

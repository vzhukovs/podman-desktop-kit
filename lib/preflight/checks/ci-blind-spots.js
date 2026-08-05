// SPDX-License-Identifier: Apache-2.0

// Preflight check: CI blind spots
//
// Some changes CI cannot judge: build and packaging configuration,
// platform-specific code paths, and the dependency graph. podman-desktop builds
// on three platforms but runs unit tests on Linux only, and its e2e failures do
// not block a merge — so a green PR is not evidence that everything in it was
// exercised.
//
// When the diff lands in one of those areas, the PR body has to say what was
// checked by hand and where. CI passing on something it never ran reads as
// proof, which is worse than CI failing.

/** @type {string} */
export const id = 'ci-blind-spots';

/** @type {boolean} */
export const blocking = true;

/**
 * Areas CI does not meaningfully cover, each with what the body has to answer.
 *
 * The ask is per area rather than one sentence for all of them, because the
 * generic version asked about the platform even when the finding was a
 * lockfile. A remedy that names the wrong thing gets answered with the wrong
 * thing, and then the check passes on a note about nothing.
 *
 * The dependency entry keys on the **lockfile**, not on package.json. A
 * package.json edited on its own — a script renamed, a version field bumped by
 * a release — installs exactly what was installed before, and asking about it
 * would price the gate at one paragraph per unrelated edit. The lockfile
 * changing is what says the resolved graph changed, which is the thing unit
 * tests on one platform do not exercise: scenario 7 is mechanical in the diff
 * and risky one level down, in transitive dependents nothing here compiles.
 */
const BLIND = [
  {
    label: 'packaging',
    test: /electron-builder|\.electron-builder|(^|\/)build\/|installer|\.entitlements|notarize/i,
    ask: 'say what you installed or packaged by hand, and on which platform',
  },
  {
    label: 'build configuration',
    test: /(^|\/)vite\.config\.|(^|\/)tsconfig[^/]*\.json$|(^|\/)\.github\/workflows\//i,
    ask: 'say what you built with the changed configuration',
  },
  {
    label: 'platform-specific code',
    test: /win32|windows|darwin|macos|linux|process\.platform/i,
    ask: 'name the platform you checked on — CI builds on three and runs unit tests on one',
  },
  {
    label: 'native or spawned binaries',
    test: /(^|\/)binaries?\/|child_process|spawn|exec\.ts$/i,
    ask: 'say what you ran that actually spawned the binary',
  },
  {
    label: 'dependency changes',
    test: /(^|\/)pnpm-lock\.yaml$|(^|\/)pnpm-workspace\.yaml$|(^|\/)\.npmrc$|(^|\/)patches\//i,
    ask: 'name what depends on what moved (`pnpm why <pkg>`) and what the changelog says between the versions — a transitive break survives a green unit run',
  },
];

/** Where the answer belongs. */
const NOTES = /Notes for reviewers([\s\S]{20,})/i;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  /** @type {Record<string, string[]>} */
  const hits = {};

  for (const file of context.changedFiles) {
    for (const area of BLIND) {
      if (area.test.test(file)) (hits[area.label] ??= []).push(file);
    }
  }

  const areas = Object.keys(hits);
  if (areas.length === 0) {
    return { id, status: 'pass', blocking, summary: 'nothing CI cannot judge' };
  }

  const asked = BLIND.filter((area) => hits[area.label]).map((area) => area.ask).join('; ');

  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: `${areas.join(', ')} — the PR body is not drafted yet`,
      remedy: `in Notes for reviewers: ${asked}. Then run preflight again`,
      output: areas.map((area) => `${area}\n  ${hits[area].join('\n  ')}`).join('\n\n'),
    };
  }

  if (!NOTES.test(context.prBody)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the diff touches ${areas.join(', ')}, and the body has no Notes for reviewers`,
      output: areas.map((area) => `${area}\n  ${hits[area].join('\n  ')}`).join('\n\n'),
      remedy: `${asked}. e2e failures do not block a merge upstream, so a green run is not the answer either`,
    };
  }

  return { id, status: 'pass', blocking, summary: `${areas.join(', ')} — covered in Notes for reviewers` };
}

// SPDX-License-Identifier: Apache-2.0

// Preflight check: CI blind spots
//
// Some changes CI cannot judge: build and packaging configuration, and
// platform-specific code paths. podman-desktop builds on three platforms but
// runs unit tests on Linux only, and its e2e failures do not block a merge —
// so a green PR is not evidence that everything in it was exercised.
//
// When the diff lands in one of those areas, the PR body has to say what was
// checked by hand and where. CI passing on something it never ran reads as
// proof, which is worse than CI failing.

/** @type {string} */
export const id = 'ci-blind-spots';

/** @type {boolean} */
export const blocking = true;

/** Areas CI does not meaningfully cover. */
const BLIND = [
  { label: 'packaging', test: /electron-builder|\.electron-builder|(^|\/)build\/|installer|\.entitlements|notarize/i },
  { label: 'build configuration', test: /(^|\/)vite\.config\.|(^|\/)tsconfig[^/]*\.json$|(^|\/)\.github\/workflows\//i },
  { label: 'platform-specific code', test: /win32|windows|darwin|macos|linux|process\.platform/i },
  { label: 'native or spawned binaries', test: /(^|\/)binaries?\/|child_process|spawn|exec\.ts$/i },
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

  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: `${areas.join(', ')} — the PR body is not drafted yet`,
      remedy: `say in Notes for reviewers what you checked by hand and on which platform, then run preflight again`,
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
      remedy: 'name the platform you checked on. CI builds on three and runs unit tests on one; e2e failures do not block a merge',
    };
  }

  return { id, status: 'pass', blocking, summary: `${areas.join(', ')} — covered in Notes for reviewers` };
}

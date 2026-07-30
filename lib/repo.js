// SPDX-License-Identifier: Apache-2.0

// Repository primitives: the package map and the git operations pdkit needs.
//
// The package map is generated from pnpm-workspace.yaml rather than written by
// hand, so it cannot drift from the actual workspace. Layer order comes from
// config and decides both merge order and which reviewers a slice will draw.

/**
 * Build the package map from pnpm-workspace.yaml and write it to
 * $PDKIT_HOME/package-map.json.
 *
 * @param {string} _repoRoot
 * @returns {Promise<{packages: Record<string, {path: string, layer: string}>, layers: string[]}>}
 */
export async function buildPackageMap(_repoRoot) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Which package owns a path.
 *
 * @param {string} _filePath repo-relative
 * @returns {Promise<{name: string, layer: string}|null>}
 */
export async function packageFor(_filePath) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Current branch name.
 *
 * @returns {Promise<string>}
 */
export async function currentBranch() {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Files changed between a base and a ref.
 *
 * @param {string} _base
 * @param {string} [_ref]
 * @returns {Promise<string[]>}
 */
export async function changedFiles(_base, _ref) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Commits on a branch, parsed into type, scope, subject, and trailers.
 *
 * @param {string} _base
 * @param {string} [_ref]
 * @returns {Promise<Array<{sha: string, type: string, scope: string|null, subject: string, trailers: Record<string, string[]>}>>}
 */
export async function commits(_base, _ref) {
  // TODO(stage 1)
  throw new Error('not implemented');
}

/**
 * Upstream commits landed since a branch point that touch the given files.
 * Feeds `pdkit drift` and the resume flow.
 *
 * @param {string} _base
 * @param {string[]} _files
 * @returns {Promise<Array<{sha: string, subject: string, files: string[]}>>}
 */
export async function drift(_base, _files) {
  // TODO(stage 4)
  throw new Error('not implemented');
}

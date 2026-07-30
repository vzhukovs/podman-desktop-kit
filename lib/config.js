// SPDX-License-Identifier: Apache-2.0

// Configuration loading and merging.
//
// Three layers, later ones overriding earlier ones per key:
//
//   1. defaults/config.yaml        shipped with the plugin
//   2. $PDKIT_HOME/config.yaml     the user's own settings
//   3. <repo>/.pdkit.yaml          per-repository overrides
//
// Note what is NOT here: model routing. That lives in the `model:` frontmatter
// of skills and agents and nowhere else — see section 5 of the spec. A second
// place to answer the same question is a second place to be wrong.

/** @typedef {import('./yaml.js').YamlMap} Config */

/** Default location of the state directory when $PDKIT_HOME is unset. */
export const DEFAULT_HOME = '~/.pdkit/podman-desktop';

/**
 * Resolve $PDKIT_HOME, expanding a leading ~.
 *
 * @returns {string} absolute path
 */
export function resolveHome() {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Load and merge the three configuration layers.
 *
 * @param {{repoRoot?: string}} [_options]
 * @returns {Promise<Config>}
 */
export async function load(_options) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Read a single value by dotted path, e.g. "slicing.max_files_per_slice".
 *
 * @param {Config} _config
 * @param {string} _path
 * @returns {unknown}
 */
export function get(_config, _path) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

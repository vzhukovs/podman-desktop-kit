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

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parse } from './yaml.js';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** The plugin's own directory. Never written to: it changes on every update. */
export const PLUGIN_ROOT = resolve(LIB_DIR, '..');

/** Defaults shipped with the plugin — the first configuration layer. */
export const DEFAULTS_PATH = join(PLUGIN_ROOT, 'defaults', 'config.yaml');

/** Default location of the state directory when $PDKIT_HOME is unset. */
export const DEFAULT_HOME = '~/.pdkit/podman-desktop';

/** Name of the per-repository override file. */
export const REPO_CONFIG_FILE = '.pdkit.yaml';

/**
 * Expand a leading `~` against the current user's home directory.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function expandTilde(filePath) {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2));
  return filePath;
}

/**
 * Read and parse a YAML file, or return null when it does not exist.
 * A file that exists but does not parse is an error: silently continuing
 * would run with settings the user believes they changed.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>|null}
 */
function readYamlSync(filePath) {
  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    return parse(source);
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`, { cause: error });
  }
}

/**
 * Resolve $PDKIT_HOME, expanding a leading ~.
 *
 * Order: the environment variable, then `state.root` from the repository
 * override, then `state.root` from the shipped defaults, then DEFAULT_HOME.
 * `$PDKIT_HOME/config.yaml` deliberately does not get a say — a file cannot
 * be consulted about where it itself lives.
 *
 * @param {{repoRoot?: string}} [options]
 * @returns {string} absolute path
 */
export function resolveHome(options = {}) {
  const fromEnv = process.env.PDKIT_HOME;
  if (fromEnv) return resolve(expandTilde(fromEnv));

  const layers = [];
  if (options.repoRoot) layers.push(join(options.repoRoot, REPO_CONFIG_FILE));
  layers.push(DEFAULTS_PATH);

  for (const layer of layers) {
    const root = get(readYamlSync(layer) ?? {}, 'state.root');
    if (typeof root === 'string' && root !== '') return resolve(expandTilde(root));
  }

  return resolve(expandTilde(DEFAULT_HOME));
}

/**
 * The configuration files, in merge order, with the location of each.
 * `doctor` reports this list; nothing else should have to know the order.
 *
 * @param {{repoRoot?: string, home?: string}} [options]
 * @returns {Array<{name: string, path: string, required: boolean}>}
 */
export function layers(options = {}) {
  const home = options.home ?? resolveHome(options);
  const list = [
    { name: 'defaults', path: DEFAULTS_PATH, required: true },
    { name: 'home', path: join(home, 'config.yaml'), required: false },
  ];
  if (options.repoRoot) {
    list.push({ name: 'repo', path: join(options.repoRoot, REPO_CONFIG_FILE), required: false });
  }
  return list;
}

/**
 * Merge two configuration layers.
 *
 * Maps merge key by key; **arrays are replaced wholesale**. Merging arrays
 * element-wise would turn an override of `never_rewrite` or `layer_order`
 * into a list nobody wrote, and both of those decide whether a command is
 * allowed to run.
 *
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
function merge(base, override) {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = merge(base[key], value);
  }
  return result;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @typedef {Record<string, unknown>} Config */

/**
 * Load and merge the three configuration layers.
 *
 * @param {{repoRoot?: string, home?: string}} [options]
 * @returns {Promise<Config>}
 */
export async function load(options = {}) {
  const home = options.home ?? resolveHome(options);
  let config = {};

  for (const layer of layers({ ...options, home })) {
    let source;
    try {
      source = await readFile(layer.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (!layer.required) continue;
        throw new Error(`missing required config layer: ${layer.path}`, { cause: error });
      }
      throw error;
    }

    try {
      config = /** @type {Config} */ (merge(config, parse(source)));
    } catch (error) {
      throw new Error(`${layer.path}: ${error.message}`, { cause: error });
    }
  }

  return config;
}

/**
 * Synchronous form of {@link load}, for the few call sites that cannot be
 * async — `branchName` is one, and duplicating the branch templates in code
 * to avoid it would be a second source of truth for the branch format.
 *
 * @param {{repoRoot?: string, home?: string}} [options]
 * @returns {Config}
 */
export function loadSync(options = {}) {
  const home = options.home ?? resolveHome(options);
  let config = {};

  for (const layer of layers({ ...options, home })) {
    const parsed = readYamlSync(layer.path);
    if (parsed === null) {
      if (layer.required) throw new Error(`missing required config layer: ${layer.path}`);
      continue;
    }
    config = /** @type {Config} */ (merge(config, parsed));
  }

  return config;
}

/**
 * Which configuration layer decides a key.
 *
 * `pdkit init` copies the whole defaults file into $PDKIT_HOME, so every value
 * the plugin later changes stays shadowed by that copy — indistinguishable, at
 * a glance, from a setting the user chose. When a report is about to blame a
 * value, it should be able to say where the value came from.
 *
 * @param {string} path dotted, e.g. "slicing.layer_order"
 * @param {{repoRoot?: string, home?: string}} [options]
 * @returns {{name: string, path: string}|null} the last layer that defines it
 */
export function definedIn(path, options = {}) {
  const home = options.home ?? resolveHome(options);

  let found = null;
  for (const layer of layers({ ...options, home })) {
    const parsed = readYamlSync(layer.path);
    if (parsed && get(/** @type {Config} */ (parsed), path) !== undefined) found = layer;
  }

  return found === null ? null : { name: found.name, path: found.path };
}

/**
 * Read a single value by dotted path, e.g. "slicing.max_files_per_slice".
 *
 * @param {Config} config
 * @param {string} path
 * @returns {unknown}
 */
export function get(config, path) {
  let node = /** @type {unknown} */ (config);

  for (const key of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }

  return node;
}

/**
 * Locations inside $PDKIT_HOME.
 *
 * `issues/<n>/state.json` is deliberately absent: naming that file here would
 * put a second module in the business of knowing where the state machine
 * lives, and section 2.2 makes lib/state.js its only writer.
 *
 * @param {string} home
 * @returns {{home: string, config: string, packageMap: string, issues: string, gates: string, active: string, journal: string, reviews: string}}
 */
export function paths(home) {
  const root = isAbsolute(home) ? home : resolve(expandTilde(home));
  return {
    home: root,
    config: join(root, 'config.yaml'),
    packageMap: join(root, 'package-map.json'),
    issues: join(root, 'issues'),
    gates: join(root, 'gates'),
    active: join(root, 'active'),
    journal: join(root, 'journal'),
    reviews: join(root, 'reviews'),
  };
}

/**
 * Directory holding every artefact of one issue.
 *
 * @param {string} home
 * @param {number|string} issue
 * @returns {string}
 */
export function issueDir(home, issue) {
  return join(paths(home).issues, String(issue));
}

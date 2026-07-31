// SPDX-License-Identifier: Apache-2.0

// Repository primitives: the package map and the git operations pdkit needs.
//
// The package map is generated from pnpm-workspace.yaml rather than written by
// hand, so it cannot drift from the actual workspace. Layer order comes from
// config and decides both merge order and which reviewers a slice will draw.

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { get, load, paths, resolveHome } from './config.js';
import { escapeRegExp } from './globs.js';
import { parse } from './yaml.js';

const run = promisify(execFile);

/** Layer given to a package no rule in `slicing.layer_order` claims. */
export const UNKNOWN_LAYER = 'other';

/**
 * Run a git command in a directory. Returns trimmed stdout, or null when git
 * refuses — "not a repository" is an answer, not a crash.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function git(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Reduce a git remote URL to `owner/name`, so ssh and https forms of the same
 * remote compare equal.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function remoteSlug(url) {
  const match = url
    .trim()
    .replace(/\.git$/, '')
    .match(/^(?:git@[^:]+:|ssh:\/\/[^/]+\/|https?:\/\/[^/]+\/)(.+)$/);

  return match ? match[1] : null;
}

/**
 * The working tree a directory belongs to, or null when it is not in one.
 *
 * Deliberately not resolveRepoRoot: this answers "which tree am I standing in"
 * and nothing else. It does not read remotes and does not care whether the tree
 * is the configured fork, because the hooks that use it run on every write and
 * must not depend on configuration being right.
 *
 * In a linked worktree `--show-toplevel` gives that worktree rather than the
 * main one, which is exactly the distinction lib/active.js is keyed on: five
 * worktrees share one $PDKIT_HOME and each runs its own task.
 *
 * @param {string} [cwd]
 * @returns {Promise<string|null>} absolute path
 */
export async function worktreeRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd ?? process.cwd());
}

/**
 * Find the repository pdkit should act on and check it is the expected one.
 *
 * A mismatch is reported, not thrown: `doctor` has to be able to say "this is
 * a git repository, just not the fork you configured" rather than fail with a
 * stack trace in whatever directory the user happened to be standing in.
 *
 * @param {{cwd?: string, config?: import('./config.js').Config}} [options]
 * @returns {Promise<{root: string|null, remotes: Record<string, string>, matches: boolean, problems: string[]}>}
 */
export async function resolveRepoRoot(options = {}) {
  const config = options.config ?? (await load());
  const configured = get(config, 'repo.path');
  const start = options.cwd ?? (typeof configured === 'string' && configured ? configured : process.cwd());

  const root = await git(['rev-parse', '--show-toplevel'], start);
  if (!root) {
    return { root: null, remotes: {}, matches: false, problems: [`${start} is not inside a git repository`] };
  }

  const listed = (await git(['remote'], root)) ?? '';
  /** @type {Record<string, string>} */
  const remotes = {};
  for (const name of listed.split('\n').filter(Boolean)) {
    const url = await git(['remote', 'get-url', name], root);
    if (url) remotes[name] = remoteSlug(url) ?? url;
  }

  const problems = [];
  for (const [remoteKey, slugKey] of [
    ['repo.upstream_remote', 'repo.upstream'],
    ['repo.fork_remote', 'repo.fork'],
  ]) {
    const remoteName = get(config, remoteKey);
    const expected = get(config, slugKey);
    if (typeof remoteName !== 'string' || typeof expected !== 'string') continue;

    const actual = remotes[remoteName];
    if (!actual) problems.push(`remote "${remoteName}" is missing (expected ${expected})`);
    else if (actual !== expected) problems.push(`remote "${remoteName}" is ${actual}, expected ${expected}`);
  }

  return { root, remotes, matches: problems.length === 0, problems };
}

/**
 * Expand one pnpm workspace pattern into directories that exist.
 *
 * Only a single `*` per segment is supported, which is all pnpm-workspace.yaml
 * uses here. `**` is refused rather than approximated: a package map that
 * quietly missed a package would misroute every slice built on it.
 *
 * @param {string} repoRoot
 * @param {string} pattern
 * @returns {Promise<string[]>} repo-relative directories
 */
async function expandPattern(repoRoot, pattern) {
  if (pattern.includes('**')) {
    throw new Error(`pnpm-workspace.yaml: "**" is not supported in "${pattern}"`);
  }

  let candidates = [''];

  for (const segment of pattern.split('/').filter(Boolean)) {
    /** @type {string[]} */
    const next = [];

    for (const base of candidates) {
      if (!segment.includes('*')) {
        next.push(base ? `${base}/${segment}` : segment);
        continue;
      }

      const matcher = new RegExp(`^${segment.split('*').map(escapeRegExp).join('.*')}$`);
      let entries;
      try {
        entries = await readdir(join(repoRoot, base), { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (!matcher.test(entry.name)) continue;
        next.push(base ? `${base}/${entry.name}` : entry.name);
      }
    }

    candidates = next;
  }

  return candidates;
}

/**
 * Assign a package to a layer by its path.
 *
 * Anything the layer list does not claim gets UNKNOWN_LAYER and is reported by
 * `doctor`. Folding it into the nearest layer instead would silently reorder
 * merges, and the wrong order is invisible until a slice fails to apply.
 *
 * @param {string} packagePath repo-relative
 * @param {string[]} layerOrder
 * @returns {string}
 */
export function layerFor(packagePath, layerOrder) {
  const [head, ...rest] = packagePath.split('/');

  // Everything under a top-level directory that is itself a layer belongs to
  // it: extensions/podman/packages/extension is still the extensions layer.
  if (layerOrder.includes(head)) return head;

  for (const layer of layerOrder) {
    if (head.startsWith(layer) || head === layer) return layer;
  }

  if (rest.length > 0) {
    const name = rest[0];
    // Longest match first, so packages/extension-api does not answer to a
    // shorter layer that happens to be a prefix.
    for (const layer of [...layerOrder].sort((a, b) => b.length - a.length)) {
      if (name === layer || name.startsWith(`${layer}-`)) return layer;
    }
  }

  return UNKNOWN_LAYER;
}

/**
 * Build the package map from pnpm-workspace.yaml and write it to
 * $PDKIT_HOME/package-map.json.
 *
 * @param {string} repoRoot
 * @param {{home?: string, config?: import('./config.js').Config, write?: boolean}} [options]
 * @returns {Promise<{generatedAt: string, workspaceRoot: string, layers: string[], packages: Record<string, {path: string, layer: string}>}>}
 */
export async function buildPackageMap(repoRoot, options = {}) {
  const config = options.config ?? (await load({ repoRoot }));
  const layerOrder = /** @type {string[]} */ (get(config, 'slicing.layer_order') ?? []);

  const workspaceFile = join(repoRoot, 'pnpm-workspace.yaml');
  const workspace = parse(await readFile(workspaceFile, 'utf8'));
  const patterns = /** @type {string[]} */ (workspace.packages ?? []);

  const included = new Set();
  const excluded = new Set();

  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const target = negated ? excluded : included;
    for (const dir of await expandPattern(repoRoot, negated ? pattern.slice(1) : pattern)) {
      target.add(dir);
    }
  }

  /** @type {Record<string, {path: string, layer: string}>} */
  const packages = {};

  for (const dir of [...included].filter((dir) => !excluded.has(dir)).sort()) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(repoRoot, dir, 'package.json'), 'utf8'));
    } catch {
      // A directory matched by a glob without a package.json is not a package.
      continue;
    }
    if (typeof manifest.name !== 'string') continue;

    packages[manifest.name] = { path: dir, layer: layerFor(dir, layerOrder) };
  }

  const map = {
    generatedAt: new Date().toISOString(),
    workspaceRoot: repoRoot,
    layers: [...layerOrder, UNKNOWN_LAYER],
    packages,
  };

  if (options.write !== false) {
    const target = paths(options.home ?? resolveHome({ repoRoot })).packageMap;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(map, null, 2)}\n`);
  }

  return map;
}

/** @typedef {{generatedAt: string, workspaceRoot: string, layers: string[], packages: Record<string, {path: string, layer: string}>}} PackageMap */

/**
 * Read the package map written by `pdkit init`.
 *
 * @param {{home?: string}} [options]
 * @returns {Promise<PackageMap>}
 */
export async function readPackageMap(options = {}) {
  const target = paths(options.home ?? resolveHome()).packageMap;
  return JSON.parse(await readFile(target, 'utf8'));
}

/**
 * Which package owns a path.
 *
 * @param {string} filePath repo-relative
 * @param {{home?: string, map?: {packages: Record<string, {path: string, layer: string}>}}} [options]
 * @returns {Promise<{name: string, path: string, layer: string}|null>}
 */
export async function packageFor(filePath, options = {}) {
  const map = options.map ?? (await readPackageMap(options));
  const normalized = filePath.split(sep).join('/').replace(/^\.\//, '');

  let best = null;
  for (const [name, entry] of Object.entries(map.packages)) {
    if (normalized !== entry.path && !normalized.startsWith(`${entry.path}/`)) continue;
    // Longest path wins: extensions/podman/packages/extension owns its files,
    // not the extension directory above it.
    if (!best || entry.path.length > best.path.length) best = { name, ...entry };
  }

  return best;
}

/**
 * Repo-relative form of a path, for callers holding an absolute one.
 *
 * @param {string} repoRoot
 * @param {string} filePath
 * @returns {string}
 */
export function relativeToRepo(repoRoot, filePath) {
  return relative(resolve(repoRoot), resolve(repoRoot, filePath)).split(sep).join('/');
}

/**
 * Current branch name.
 *
 * `git branch --show-current` rather than `rev-parse --abbrev-ref HEAD`: it
 * answers on a repository with no commits yet, and it says nothing at all on a
 * detached HEAD instead of the word "HEAD", which would otherwise be taken for
 * a branch name.
 *
 * @param {{cwd?: string}} [options]
 * @returns {Promise<string|null>} null outside a repository, or on a detached HEAD
 */
export async function currentBranch(options = {}) {
  const name = await git(['branch', '--show-current'], options.cwd ?? process.cwd());
  return name === null || name === '' ? null : name;
}

/**
 * Paths changed between a base and a ref, with the status git gave each one.
 *
 * Three dots, not two: `main...HEAD` is what the branch added since it forked,
 * while `main..HEAD` also reports everything main gained in the meantime. On a
 * branch that is a week behind, the two differ by the whole week, and preflight
 * would then lint files the branch never touched.
 *
 * @param {string} base
 * @param {string} [ref]
 * @param {{cwd?: string}} [options]
 * @returns {Promise<Array<{status: string, path: string}>>} status is git's letter: A, M, D, R…
 */
export async function changedPaths(base, ref = 'HEAD', options = {}) {
  const output = await git(
    ['diff', '--name-status', '--find-renames', `${base}...${ref}`],
    options.cwd ?? process.cwd(),
  );
  if (output === null || output === '') return [];

  return output.split('\n').map((line) => {
    const fields = line.split('\t');
    // A rename is `R100<TAB>old<TAB>new`; the new path is what exists now.
    return { status: fields[0], path: fields[fields.length - 1] };
  });
}

/**
 * Files changed between a base and a ref.
 *
 * @param {string} base
 * @param {string} [ref]
 * @param {{cwd?: string}} [options]
 * @returns {Promise<string[]>}
 */
export async function changedFiles(base, ref = 'HEAD', options = {}) {
  return (await changedPaths(base, ref, options)).map((entry) => entry.path);
}

/**
 * Commits a branch adds on top of a base, with their message trailers.
 *
 * Deliberately not parsed into type and scope, though the skeleton's signature
 * said so. Whether a subject is a valid conventional commit is an upstream
 * rule, and upstream rules live in lib/upstream.js so that the hook and
 * preflight cannot disagree about them. This module reports what git says and
 * stops there.
 *
 * Trailers are collected from every line of the body rather than from the last
 * paragraph only. That is looser than git's own definition and matches the
 * thing being mirrored: `.husky/commit-msg` counts `^Signed-off-by: ` lines
 * anywhere in the message and rejects a duplicate, so counting them the same
 * way is what makes preflight predict the hook.
 *
 * @param {string} base
 * @param {string} [ref]
 * @param {{cwd?: string}} [options]
 * @returns {Promise<Array<{sha: string, subject: string, body: string, trailers: Record<string, string[]>}>>}
 */
export async function commits(base, ref = 'HEAD', options = {}) {
  // Null bytes between fields and a record separator between commits: a commit
  // message can contain anything, including whatever delimiter looked safe.
  const output = await git(
    ['log', '--no-merges', '--format=%H%x00%s%x00%b%x1e', `${base}..${ref}`],
    options.cwd ?? process.cwd(),
  );
  if (output === null || output === '') return [];

  return output
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, subject, body = ''] = record.split('\x00');
      return { sha, subject, body, trailers: parseTrailers(body) };
    });
}

/** `Signed-off-by: A <a@b>` — a token, a colon, a space, a value. */
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.*)$/;

/**
 * Collect message trailers, keeping repeats.
 *
 * Repeats are the point: "exactly one Signed-off-by" cannot be checked by a
 * map that keeps the last value.
 *
 * @param {string} body
 * @returns {Record<string, string[]>}
 */
export function parseTrailers(body) {
  /** @type {Record<string, string[]>} */
  const trailers = {};

  for (const line of String(body ?? '').split('\n')) {
    const match = TRAILER.exec(line.trim());
    if (!match) continue;
    (trailers[match[1]] ??= []).push(match[2].trim());
  }

  return trailers;
}

/**
 * The scripts a repository defines, by name.
 *
 * Preflight resolves what to run from this rather than from a list baked into
 * the plugin (spec section 7): podman-desktop has no `pnpm lint`, its
 * `pnpm test` drags in e2e, and upstream renames scripts without warning. A
 * hardcoded name that stops existing becomes a check that silently never runs.
 *
 * @param {string} repoRoot
 * @returns {Promise<Record<string, string>>} empty when there is no package.json
 */
export async function scripts(repoRoot) {
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    return manifest.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * First script from a list of candidates that the repository actually defines.
 *
 * @param {Record<string, string>} available
 * @param {string[]} candidates   most specific first
 * @returns {string|null}
 */
export function pickScript(available, candidates) {
  return candidates.find((name) => name in available) ?? null;
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

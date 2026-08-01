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
 * Local branch names.
 *
 * @param {{cwd?: string}} [options]
 * @returns {Promise<string[]>}
 */
export async function branches(options = {}) {
  const raw = await git(['branch', '--format=%(refname:short)'], options.cwd ?? process.cwd());
  return raw === null ? [] : raw.split('\n').map((name) => name.trim()).filter(Boolean);
}

/**
 * Paths changed between a base and a ref, with the status git gave each one.
 *
 * Three dots, not two: `main...HEAD` is what the branch added since it forked,
 * while `main..HEAD` also reports everything main gained in the meantime. On a
 * branch that is a week behind, the two differ by the whole week, and preflight
 * would then lint files the branch never touched.
 *
 * Rename detection is on by default and off for slicing. A rename reported as
 * `R100 old new` names two paths and this function keeps one, which is fine for
 * a report and wrong for a slice: the slice would carry the new file and leave
 * the old one behind. With `renames: false` the same change arrives as a delete
 * and an add, both assignable to a slice, and a partial diff of it is exact.
 *
 * @param {string} base
 * @param {string} [ref]
 * @param {{cwd?: string, renames?: boolean}} [options]
 * @returns {Promise<Array<{status: string, path: string}>>} status is git's letter: A, M, D, R…
 */
export async function changedPaths(base, ref = 'HEAD', options = {}) {
  const output = await git(
    ['diff', '--name-status', options.renames === false ? '--no-renames' : '--find-renames', `${base}...${ref}`],
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
 * Where a branch left its base.
 *
 * merge-base rather than the base ref itself, and for a stacked slice the base
 * is the predecessor's branch rather than main. Measuring drift from main for a
 * stacked slice would report the previous slice's own commits as upstream
 * movement — the same mistake preflight made before its base came from the
 * graph (spec section 7).
 *
 * @param {string} ref
 * @param {string} base
 * @param {{cwd?: string}} [options]
 * @returns {Promise<string|null>} null when the two share no history
 */
export async function branchPoint(ref, base, options = {}) {
  return git(['merge-base', ref, base], options.cwd ?? process.cwd());
}

/**
 * Commits on `to` that are not on `from` and that touch the given files.
 *
 * Feeds `pdkit drift` and the resume flow. The file list is the question, not a
 * convenience: what matters on return from a break is not how far upstream
 * moved, but whether it moved under our feet.
 *
 * @param {{from: string, to: string, files: string[], cwd?: string, limit?: number}} input
 * @returns {Promise<Array<{sha: string, subject: string, author: string, at: string, files: string[]}>>}
 */
export async function drift(input) {
  const cwd = input.cwd ?? process.cwd();
  if (input.files.length === 0) return [];

  // --name-only with a NUL record separator, because a commit subject may
  // contain anything at all including the characters a line-based parse would
  // have relied on.
  const raw = await git(
    [
      'log',
      `${input.from}..${input.to}`,
      `--max-count=${input.limit ?? 200}`,
      '--name-only',
      '--no-merges',
      '--format=%x00%H%x1f%an%x1f%aI%x1f%s',
      '--',
      ...input.files,
    ],
    cwd,
  );
  if (raw === null) return [];

  const commits = [];
  for (const record of raw.split('\0')) {
    if (record.trim() === '') continue;

    const [header, ...rest] = record.split('\n');
    const [sha, author, at, subject] = header.split('\x1f');

    commits.push({
      sha,
      author: author ?? '',
      at: at ?? '',
      subject: subject ?? '',
      files: rest.map((line) => line.trim()).filter((line) => line !== ''),
    });
  }

  return commits;
}

/** `@@ -old,count +new,count @@` — the new-side range is what we compare. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * How many lines each file of a diff gained and lost.
 *
 * A binary file reports `-` for both, which is not zero and is not a number:
 * it comes back as null so a caller can tell "no lines" from "not lines".
 *
 * @param {string} base
 * @param {string} [ref]
 * @param {{cwd?: string}} [options]
 * @returns {Promise<Array<{path: string, added: number|null, removed: number|null}>>}
 */
export async function changedLines(base, ref = 'HEAD', options = {}) {
  const raw = await git(['diff', '--numstat', `${base}...${ref}`], options.cwd ?? process.cwd());
  if (raw === null) return [];

  const count = (value) => (value === '-' ? null : (Number.parseInt(value, 10) || 0));

  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: count(added), removed: count(removed) };
    })
    .filter((entry) => entry.path !== '');
}

/**
 * Which ref the base branch actually means here.
 *
 * `repo.base_branch` is a NAME, and on a fork the local branch carrying that
 * name is not the base a pull request opens against — it is a copy of it, as
 * current as the last time somebody pulled. Found on the first live run: a
 * local `main` 491 commits behind upstream turned a two-file diff into an
 * 805-file one, and preflight reported four blocking failures about other
 * people's work — SPDX on a file we never touched, 87 commits with the wrong
 * sign-off, eight public API symbols. Nothing looked wrong: the base was a real
 * commit, the diff applied, every check did exactly what it says.
 *
 * So the remote-tracking ref wins when it resolves. It can be stale too — it is
 * only as fresh as the last fetch — which is why the date and sha come back with
 * it rather than being assumed away.
 *
 * @param {{cwd: string, base: string, config?: object}} input
 * @returns {Promise<{ref: string, kind: 'remote'|'local'|'unresolved', sha: string|null, at: string|null, localBehind: number|null}>}
 */
export async function resolveBase(input) {
  const remote = String(get(input.config ?? {}, 'repo.upstream_remote') ?? 'upstream');
  const tracking = `${remote}/${input.base}`;

  const resolvable = async (ref) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], input.cwd)) !== null;

  const hasTracking = await resolvable(tracking);
  const hasLocal = await resolvable(input.base);

  const ref = hasTracking ? tracking : input.base;
  const kind = hasTracking ? 'remote' : hasLocal ? 'local' : 'unresolved';

  // How far the local branch has fallen behind, when both exist. Not an error —
  // the diff no longer depends on it — but it is the thing to fix before the
  // next branch is cut, and saying it here is cheaper than finding out later.
  const localBehind =
    hasTracking && hasLocal
      ? Number.parseInt((await git(['rev-list', '--count', `${input.base}..${tracking}`], input.cwd)) ?? '', 10) || 0
      : null;

  return {
    ref,
    kind,
    sha: kind === 'unresolved' ? null : await git(['rev-parse', '--short', ref], input.cwd),
    at: kind === 'unresolved' ? null : await git(['log', '-1', '--format=%cI', ref], input.cwd),
    localBehind,
  };
}

/**
 * The line ranges a commit touched in one file.
 *
 * `--unified=0` so a range means what it says: with context lines a one-line
 * change claims six, and a claim that upstream touched the line the plan cited
 * is the difference between a mechanical conflict and a stop.
 *
 * @param {string} sha
 * @param {string} file
 * @param {{cwd?: string}} [options]
 * @returns {Promise<Array<[number, number]>>}
 */
export async function touchedRanges(sha, file, options = {}) {
  const raw = await git(['show', '--unified=0', '--format=', sha, '--', file], options.cwd ?? process.cwd());
  if (!raw) return [];

  const ranges = [];
  for (const line of raw.split('\n')) {
    const match = HUNK.exec(line);
    if (!match) continue;

    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    // A pure deletion is `+n,0`: nothing occupies the new side, but the lines
    // that were there are gone, which is exactly what a citation cares about.
    ranges.push([start, start + Math.max(count, 1) - 1]);
  }

  return ranges;
}

/**
 * Fetch a published pull request head into the local repository.
 *
 * This is all `--from-pr` is (scenario 13), and all `/pd:review-pr` needs to
 * see a diff: the work already knows how to read a base and a ref, so making
 * someone else's published change readable is a matter of giving it a local ref
 * to be — not of abstracting the diff a second time. `refs/pull/<k>/head` is
 * served by the upstream remote whoever opened the pull request, so this works
 * on a PR that is not ours, which is the whole point in both scenarios.
 *
 * The base is the merge base rather than the base branch tip. Upstream has
 * moved since the pull request was opened, and diffing against the tip would
 * hand the caller every commit that landed in between as though the author had
 * written it.
 *
 * Here rather than in lib/gh.js because none of it is `gh`: it is four git
 * commands against a remote, and the modules that need it — the slicer and the
 * review collector — already depend on this one.
 *
 * @param {{pr: number, repoRoot: string, config?: object, remote?: string, base?: string}} input
 * @returns {Promise<{ref: string, base: string, baseBranch: string}>}
 */
export async function fetchPullRequestHead(input) {
  const config = input.config ?? {};
  const remote = input.remote ?? String(get(config, 'repo.upstream_remote') ?? 'upstream');
  const baseBranch = input.base ?? String(get(config, 'repo.base_branch') ?? 'main');

  const fetched = await git(['fetch', remote, `refs/pull/${input.pr}/head`], input.repoRoot);
  if (fetched === null) throw new Error(`cannot fetch refs/pull/${input.pr}/head from ${remote}`);

  const ref = await git(['rev-parse', 'FETCH_HEAD'], input.repoRoot);
  if (!ref) throw new Error(`fetched #${input.pr} but FETCH_HEAD does not resolve`);

  // And the base branch, before asking where they branched. A merge base is
  // only as current as the ref it is measured against: on a clone whose
  // upstream/main was two months old, this returned that two-month-old tip and
  // the "diff of the pull request" came back carrying 446 commits of other
  // people's work. Found on a live pull request, and it was silent — the base
  // was a real commit on main, the diff applied, and nothing looked wrong until
  // the file count was compared with what GitHub reported.
  await git(['fetch', remote, baseBranch], input.repoRoot);

  // FETCH_HEAD first: the fetch above just wrote the base branch there, and it
  // is current by construction. The remote-tracking branch is the fallback for
  // a clone that fetches with `--no-write-fetch-head`, and the local branch for
  // a fork that only ever fetched its own.
  const candidates = ['FETCH_HEAD', `${remote}/${baseBranch}`, baseBranch];
  let base = null;
  for (const candidate of candidates) {
    base = await git(['merge-base', ref, candidate], input.repoRoot);
    if (base) break;
  }
  if (!base) throw new Error(`cannot find where #${input.pr} branched: neither ${candidates.join(' nor ')} resolves`);

  return { ref, base, baseBranch };
}

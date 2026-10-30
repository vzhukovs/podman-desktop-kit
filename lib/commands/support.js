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

// What more than one command handler needs: exit codes, `--json` output, the
// repository a command works on, the refusal that holds a command to its
// issue's tree.
//
// Imported by lib/cli.js and by the handlers under lib/commands/, and imports
// neither: a helper that reached back into the dispatcher would make every
// command module load the whole of it.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { get, load, resolveHome } from '../config.js';
import * as gh from '../gh.js';
import * as ids from '../ids.js';
import * as pr from '../pr.js';
import { currentBranch, resolveRepoRoot } from '../repo.js';
import { printable } from '../reveal.js';
import * as slice from '../slice.js';
import * as state from '../state.js';
import * as worktree from '../worktree.js';

/** lib/, which hook handlers are loaded from. This file is one level below it. */
export const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_ROOT = join(LIB_DIR, '..');

/** Read the plugin version from package.json. */
export async function readVersion() {
  const raw = await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

/**
 * Exit codes. BLOCK is the one the hook protocol cares about: a hook that
 * exits 2 stops the tool call and feeds stderr back to the model.
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  BLOCK: 2,
};

/**
 * @param {unknown} value
 */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * `--issue` as a number, NaN when it is missing or is not one.
 *
 * Only the parse, not the check: each command words its own refusal, and which
 * check comes first is part of what it prints.
 *
 * @param {Record<string, any>} flags
 * @returns {number}
 */
export function issueFlag(flags) {
  return Number.parseInt(String(flags.issue), 10);
}

/**
 * Resolve the repository every repo-aware command works on.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<{root: string|null, remotes: Record<string, string>, matches: boolean, problems: string[], config: import('../config.js').Config}>}
 */
export async function repoContext(flags) {
  const cwd = typeof flags.repo === 'string' ? flags.repo : undefined;
  const config = await load({ repoRoot: cwd });
  return { ...(await resolveRepoRoot({ cwd, config })), config };
}

/**
 * One word of a shell command, quoted only when it has to be.
 *
 * @param {string} word
 * @returns {string}
 */
export function shellWord(word) {
  return /^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The command a person typed, rebuilt so a refusal can hand it back.
 *
 * `--repo` is dropped: the refusal names the tree with `cd`, and a `--repo`
 * still pointing at the wrong tree would undo it.
 *
 * @param {string[]} words   the command and its positional arguments
 * @param {Record<string, string|boolean|Array<string|boolean>>} flags
 * @returns {string}
 */
export function commandLine(words, flags) {
  const parts = ['pdkit', ...words.map((word) => shellWord(String(word)))];
  for (const [name, value] of Object.entries(flags)) {
    if (name === 'repo') continue;
    for (const one of [value].flat()) parts.push(one === true ? `--${name}` : `--${name} ${shellWord(String(one))}`);
  }
  return parts.join(' ');
}

/**
 * Hold a command to the tree of the issue it was asked about.
 *
 * It refuses rather than moving to the right tree, and that is the choice, not
 * a stopgap. Running somewhere other than where the person is standing means
 * the report describes one tree while their editor, their `git status` and
 * their next commit are in another — the same split that made DESKTOP-18915's
 * failure invisible, just pointed the other way. A refusal costs one paste,
 * and only because it names the paste: the exact command, prefixed with the
 * `cd` that makes it right. A refusal that says "wrong tree" and stops is one
 * more dead end.
 *
 * It runs before anything expensive, which is what makes it a precondition and
 * not a finding: seconds to say no, rather than minutes of tests on somebody
 * else's code followed by a line at the bottom of the report.
 *
 * `unclaimed` goes through. Nothing names the issue anywhere and the tree names
 * no issue either — the start of the work, an investigation on `main`. That is
 * not a mix-up, and whatever is wrong with it the checks still say.
 *
 * @param {{issue: number, repo: {root: string, config: object}, command: string, words: string[], flags: Record<string, any>, json?: object, alternative?: (home: {source: string, path: string|null, branch: string|null}) => string|null}} input
 * @returns {Promise<{ok: boolean, tree: Awaited<ReturnType<typeof worktree.forIssue>>}>}
 */
export async function requireIssueTree(input) {
  const tree = await worktree.forIssue({ issue: input.issue, cwd: input.repo.root });
  if (tree.verdict !== 'foreign') return { ok: true, tree };

  const issue = input.issue;
  const typed = commandLine(input.words, input.flags);
  // `repo.path` in the config outranks the cwd in resolveRepoRoot, so a `cd`
  // alone would land back here. Said explicitly rather than left to fail.
  const pinned = typeof get(input.repo.config, 'repo.path') === 'string' && get(input.repo.config, 'repo.path') !== '';
  const at = (path) => `cd ${shellWord(path)} && ${typed}${pinned ? ` --repo ${shellWord(path)}` : ''}`;

  const describe = (side) => `${side.path ?? '(no tree)'} on ${side.branch ?? 'a detached HEAD'}`;
  const lines = [`this tree is not DESKTOP-${issue}'s, so nothing was run.`, `  here    ${describe(tree.here)}${tree.here.issue === null ? '' : ` — issue ${tree.here.issue}`}`];

  /** @type {string[]} */
  const commands = [];
  const home = tree.home;

  if (home?.source === 'worktree') {
    lines.push(`  ${issue}   ${describe(home)} — its registered worktree`);
    commands.push(at(/** @type {string} */ (home.path)));
  } else if (home?.source === 'checkout') {
    // The main checkout is the template worktrees are made from, so the branch
    // moves out of it into a tree of its own; git will not check one branch out
    // in two trees, hence the switch first.
    lines.push(`  ${issue}   ${describe(home)} — the main checkout, which stays on the base branch`);
    const root = await worktree.rootFor({ repoRoot: tree.here.path, config: input.repo.config });
    const base = String(get(input.repo.config, 'repo.base_branch') ?? 'main');
    commands.push(
      `git -C ${shellWord(String(home.path))} switch ${shellWord(base)} && pdkit worktree create --issue ${issue} --branch ${shellWord(String(home.branch))} && ${at(join(root, `DESKTOP-${issue}`))}`,
    );
  } else if (home?.source === 'branch') {
    lines.push(`  ${issue}   ${home.branch}, a local branch checked out nowhere`);
    const root = await worktree.rootFor({ repoRoot: tree.here.path, config: input.repo.config });
    const create = `pdkit worktree create --issue ${issue} --branch ${shellWord(String(home.branch))} && ${at(join(root, `DESKTOP-${issue}`))}`;
    const change = `cd ${shellWord(tree.here.path)} && git switch ${shellWord(String(home.branch))} && ${typed}`;
    // A tree holding another issue's branch is somebody's work in progress, and
    // switching it is the remedy that disturbs it; a new tree leaves it alone.
    // The main checkout is never offered: it is nobody's tree to switch.
    if (tree.here.main) commands.push(create);
    else commands.push(...(tree.here.issue === null ? [change, create] : [create, change]));
  } else {
    lines.push(`  ${issue}   nothing names it: no worktree, no DESKTOP-${issue}/… branch`);
    commands.push(`pdkit branch create --issue ${issue} --slug <slug>`);
  }

  const extra = home ? (input.alternative?.(home) ?? null) : null;
  if (extra) commands.push(extra);

  if (home) {
    lines.push('  Run it where the issue is:', `    ${commands[0]}`);
    for (const other of commands.slice(1)) lines.push('  or', `    ${other}`);
  } else {
    lines.push('  Check the issue number. If it is right, the work has no branch yet:', `    ${commands[0]}`);
  }

  if (input.flags.json) {
    printJson({ issue, ok: false, problem: tree.reason, here: tree.here, home: tree.home, commands, ...(input.json ?? {}) });
  } else {
    process.stderr.write(`${input.command}: ${lines.join('\n')}\n`);
  }

  return { ok: false, tree };
}

/**
 * Refuse a `--ref` that names another issue's branch.
 *
 * A ref somebody typed is not a tree that happened to be under the shell, so it
 * is trusted further — a sha, a tag, `upstream/main` all go through. A branch
 * named for a different issue does not: that is the 18915 mistake made on
 * purpose, and it costs nothing to catch.
 *
 * @param {string} command
 * @param {number} issue
 * @param {string} ref
 * @returns {boolean} true when it was refused
 */
export function refusedRef(command, issue, ref) {
  const named = ids.parseBranch(ref.replace(/^refs\/heads\//, ''))?.issue ?? null;
  if (named === null || named === issue) return false;
  process.stderr.write(`${command}: --ref ${ref} is issue ${named}'s branch, and this run is for ${issue}\n`);
  return true;
}

/**
 * `sonnet 14, opus 5` — the count a written model came from.
 *
 * @param {Record<string, number>} counts
 * @returns {string}
 */
export function counted(counts) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([model, count]) => `${model} ${count}`)
    .join(', ');
}

/**
 * Whether the branch a worktree holds has a merged pull request recorded.
 *
 * Lives here rather than in lib/worktree.js because that module is deliberately
 * kept off lib/pr.js — which reads lib/slice.js, which reads lib/worktree.js.
 * The knowledge belongs to whoever owns both, and that is this file.
 *
 * Never throws. A worktree that cannot be inspected is one this knows nothing
 * about, and "nothing recorded" is the answer that keeps the ancestry check.
 *
 * @param {string|null} repoRoot
 * @param {string} name
 * @param {number} issue
 * @param {object} config
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function treeHasLanded(repoRoot, name, issue, config, home) {
  if (!repoRoot || !Number.isInteger(issue)) return false;

  try {
    const root = await worktree.rootFor({ repoRoot, config });
    const tree = (await worktree.list(repoRoot)).find((entry) => entry.path === join(root, name));
    if (!tree?.branch) return false;

    return pr.landed(await pr.read(issue, { home }), tree.branch) !== null;
  } catch {
    return false;
  }
}

/**
 * The base a pull request for this branch opens against, checked.
 *
 * The graph is read BEFORE the write, not after it. A stacked slice's base is
 * the predecessor's branch — preflight measured the diff against exactly that —
 * and the pull request has to open against the same thing or it carries work
 * its own body says it does not.
 *
 * Shared by `pr create` and `publish`, and in `publish` it runs before the push:
 * a base upstream does not have is then refused while nothing is public yet.
 *
 * @param {{issue: number, branch: string, base?: unknown, config: object, home: string}} input
 * @returns {Promise<{ok: true, base: string, index: number|null} | {ok: false, error: string}>}
 */
export async function pullRequestBase(input) {
  const { config } = input;
  const graph = await slice.read(input.issue, { home: input.home });
  const entry = graph?.slices.find((item) => item.branch === input.branch) ?? null;
  const index = entry?.index ?? null;

  const defaultBase = String(get(config, 'repo.base_branch') ?? 'main');
  const stackedOn = entry?.baseSlice ? (graph?.slices.find((item) => item.index === entry.baseSlice)?.branch ?? null) : null;
  const base = typeof input.base === 'string' ? input.base : (stackedOn ?? defaultBase);

  // A base that is not the default has to be a branch of the repository the
  // pull request opens against, and a slice branch lives in the fork. This is
  // where the first multi-slice live run went wrong: the stack was verified,
  // preflighted and shown to the user against slice #1's branch, and then
  // opened against `main` with four files instead of two.
  //
  // Checked before gh.createPullRequest, so a refusal leaves the token
  // unspent and no pull request behind.
  if (base !== defaultBase) {
    const exists = await gh.upstreamBranchExists(base, { config });
    if (exists === false) {
      return {
        ok: false,
        error:
          `${base} is not a branch of ${get(config, 'repo.upstream')}, so no pull request can open against it.\n` +
          (stackedOn === base
            ? `  Slice #${index} is stacked on it, and a stack is only expressible when the branches and the pull\n` +
              '  requests live in the same repository. Working from a fork, they do not.\n' +
              '  Either merge that slice first and run this again, or open against ' +
              `${defaultBase} with --base ${defaultBase} —\n` +
              '  and then the body has to say that the diff carries the other slice until it lands.\n'
            : '  A base is a branch of the repository the pull request opens against, not of your fork.\n'),
      };
    }
    if (exists === null) {
      return { ok: false, error: `could not check whether ${base} exists in ${get(config, 'repo.upstream')}\n` };
    }
  }

  return { ok: true, base, index };
}

/**
 * Open the pull request, record it, and move the issue to pr-open.
 *
 * Throws when GitHub refuses; `unrecorded` is set when the pull request exists
 * and the record could not follow it.
 *
 * @param {{issue: number, branch: string, base: string, index: number|null, title: string, body: string, config: object, home: string}} input
 * @returns {Promise<{result: {number: number|null, url: string, base: string}, unrecorded: string|null}>}
 */
export async function openPullRequest(input) {
  // gh.createPullRequest verifies and spends the token itself. It is not
  // trusted from here: the Bash hook cannot see a child process, so this is
  // the only place that check can live for the plugin's own path.
  const result = await gh.createPullRequest({
    head: input.branch,
    base: input.base,
    title: input.title,
    body: input.body,
    config: input.config,
    home: input.home,
  });

  // Registered here rather than left to the flow. A pull request whose number
  // exists only in the transition reason is a pull request no later command
  // can find, and a step that can be forgotten is a step that will be.
  if (result.number) {
    await pr.register({
      issue: input.issue,
      number: result.number,
      slice: input.index,
      branch: input.branch,
      // What was opened, not what was asked for.
      base: result.base,
      url: result.url,
      home: input.home,
    });
  }

  const moved = await state.transition(input.issue, 'pr-open', { reason: `#${result.number} ${result.url}`, home: input.home });
  return { result, unrecorded: moved.ok ? null : moved.error };
}

/**
 * A title for the follow-up issue.
 *
 * Derived from `--what` rather than asked for, because `--what` is already the
 * one-sentence statement of the thing, and a command that demanded both would
 * get the same sentence typed twice. `--title` overrides when the two genuinely
 * differ — a feature request is usually titled by what should exist, while
 * `--what` records what was set aside.
 *
 * Deliberately **not truncated**. Upstream titles run to a hundred characters
 * (`Since podman machine support is removed from Win10, the button 'Update to
 * v6' shouldnt displayed on Win10.`), and a title cut mid-clause says less than
 * a long one while looking finished. The draft is a file you edit; shortening is
 * a judgement, and this is not the place it gets made silently.
 *
 * @param {string} what
 * @returns {string}
 */
export function titleFrom(what) {
  const text = String(what ?? '').trim().replace(/\s+/g, ' ').replace(/[.]+$/, '');
  if (!text) return '';

  // Only the first letter, and only when it is one. `kind cluster creation
  // fails…` is a real upstream title, and capitalising a command name would be
  // a change to what the sentence names rather than to how it is written.
  return /^[a-z]/.test(text) && !/^[a-z-]+ (cluster|machine|desktop)\b/.test(text)
    ? text[0].toUpperCase() + text.slice(1)
    : text;
}

/** How long ago, in the units a person reads a backlog in. */
export function ageOf(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return '—';
  if (days === 0) return 'today';
  return `${days}d`;
}

/**
 * The issue a command means: the one typed, or the one this tree's branch is
 * for.
 *
 * Falling back to the branch is what makes `pdkit editor` a word rather than a
 * lookup — the person is usually standing in the tree they want opened, and
 * DESKTOP-<n>/… already says which issue that is.
 *
 * Digits only. `Number.parseInt` reads `12abc` as 12, which turns a typo — or
 * text that was never a number — into somebody else's issue.
 *
 * @param {string|undefined} given
 * @param {{root: string|null}} repo
 * @returns {Promise<{issue?: number, error?: string}>}
 */
export async function issueMeant(given, repo) {
  if (given !== undefined) {
    return /^\d{1,9}$/.test(String(given)) ? { issue: Number(given) } : { error: `not an issue number: ${printable(given, 40)}` };
  }

  const branch = repo.root ? await currentBranch({ cwd: repo.root }) : null;
  const parsed = branch ? ids.parseBranch(branch) : null;
  if (parsed) return { issue: parsed.issue };

  return { error: `an issue number is required — ${branch ? `${printable(branch, 80)} is not a DESKTOP-<n>/… branch` : 'this is not on a DESKTOP-<n>/… branch'}` };
}

/**
 * Where an issue's work is checked out, or why there is no such tree.
 *
 * `forIssue` already answers this for the scope check, including the case of
 * an issue whose tree is not the one the command was run from — which is the
 * normal case here, run from the main checkout. Its `reason` is not passed on:
 * it quotes branch names, and these commands' output is read by a model.
 *
 * @param {number} issue
 * @param {{root: string|null}} repo
 * @returns {Promise<{path?: string, error?: string}>}
 */
export async function treeOf(issue, repo) {
  if (!repo.root) return { error: 'not inside a git repository' };

  const found = await worktree.forIssue({ issue, cwd: repo.root });
  if (found.verdict === 'ours') return { path: found.here.path };
  if (found.home?.source === 'worktree' && found.home.path) return { path: found.home.path };
  if (found.home?.source === 'checkout') {
    const base = String(get(repo.config, 'repo.base_branch') ?? 'main');
    return {
      error:
        `DESKTOP-${issue} has no worktree; its branch ${found.home.branch} is held by the main checkout\n` +
        `  move it out: git -C ${shellWord(String(found.home.path))} switch ${shellWord(base)} && pdkit worktree create --issue ${issue} --branch ${shellWord(String(found.home.branch))}`,
    };
  }

  return { error: `DESKTOP-${issue} has no worktree\n  create one: pdkit worktree create --issue ${issue} --slug <slug>` };
}

/**
 * $PDKIT_HOME as the person set it — the environment, or the shipped default —
 * and never as a repository's .pdkit.yaml moved it.
 *
 * Every other command reads `state.root` from all three layers, and that stays.
 * These two start programs: a repository that moves the state directory also
 * chooses the config.yaml `editor.path` is read from, and on macOS chooses
 * what `open` runs. So here a repository that disagrees is refused, not
 * followed.
 *
 * @param {{root: string|null}} repo
 * @returns {{home?: string, error?: string}}
 */
export function trustedHome(repo) {
  const home = resolveHome();
  if (repo.root && resolveHome({ repoRoot: repo.root }) !== home) {
    return {
      error:
        `state.root is set by ${join(repo.root, '.pdkit.yaml')}, and a repository does not choose what this command opens or runs\n` +
        '  set PDKIT_HOME to that directory instead, if it is yours',
    };
  }
  return { home };
}

/**
 * Print what a window-opening command did.
 *
 * The path always goes to stdout, opened or not: it is the part that is still
 * useful when no window appears. Not opening is the exit code, because opening
 * is the whole of what these commands were asked to do. Everything printed
 * passes through `printable`: a directory's name is whoever made it's text.
 *
 * @param {string} command
 * @param {string} path
 * @param {{opened: boolean, reason?: string, command?: string}} result
 * @param {Record<string, string|boolean>} flags
 * @param {string} [hint] printed after the reason, for a failure the person fixes
 * @returns {number}
 */
export function reportOpened(command, path, result, flags, hint) {
  if (flags.json) {
    printJson({ path, ...result });
  } else {
    process.stdout.write(`${printable(path)}\n`);
    if (!result.opened) process.stderr.write(`pdkit ${command}: not opened: ${printable(result.reason)}\n${hint ?? ''}`);
  }
  return result.opened ? EXIT.OK : EXIT.ERROR;
}

/**
 * How much of a red run is printed after the path to it.
 *
 * The tail rather than the head: a test runner prints the failing assertion,
 * its diff and the summary at the end, and the first forty lines of a red
 * `pnpm test:main` are the same forty lines a green one starts with.
 */
export const FAILURE_TAIL_LINES = 40;

/**
 * Say where a captured run was written, and nothing more unless it failed.
 *
 * What is printed lands in the model's context and stays there for the rest of
 * the session; a single receipt reached 454 KB, and `e2e stability` printed
 * three Playwright runs in a row. `slice verify` already answered with the path
 * alone, and this is the same answer for every other command that captures.
 *
 * Only the PRINTING is shortened. The file holds the whole capture, digested,
 * and must: lib/evidence.js explains why a truncated record is worse than none.
 * Do not "fix" this by trimming the capture or the receipt — trim here or
 * nowhere.
 *
 * @param {{path: string, run: import('../evidence.js').Capture, digest: string}} input
 * @returns {string}
 */
export function describeRun(input) {
  const { path, run } = input;
  const exit = run.exitCode === null ? 'none — killed' : String(run.exitCode);
  let text = `${path}\n  exit ${exit}, ${run.durationMs}ms, ${input.digest}\n`;
  if (!run.complete) text += `  capture incomplete — ${run.incompleteBecause ?? 'reason not recorded'}\n`;

  if (run.exitCode !== 0) {
    const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\s+$/, '').split('\n');
    const shown = lines.slice(-FAILURE_TAIL_LINES);
    text +=
      `  ${lines.length > shown.length ? `last ${shown.length} of ${lines.length} lines` : 'the whole run'}; ` +
      'the rest is in the file:\n' +
      `${shown.map((line) => `  | ${line}`).join('\n')}\n`;
  }

  return text;
}

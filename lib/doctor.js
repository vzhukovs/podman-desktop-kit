// SPDX-License-Identifier: Apache-2.0

// The environment check behind `/pd:doctor`.
//
// Two rules shape every check here. Nothing is reported as available without
// being exercised — a doctor that trusts a config file tells the user what
// they wrote, not what they have. And a missing optional dependency is
// reported together with what degrades because of it: "no Playwright" is not
// actionable, "no Playwright, so /pd:validate produces a checklist and never
// sets PASS" is.

import { execFile, spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { start as startTask } from './active.js';
import { DEFAULTS_PATH, definedIn, get, layers, load, paths, resolveHome } from './config.js';
import { HOOK_HANDLERS } from './hooks/events.js';
import { UNKNOWN_LAYER, resolveRepoRoot } from './repo.js';
import { setOwns } from './state.js';
import { list as listWorktrees, rootFor } from './worktree.js';
import { parse } from './yaml.js';

const run = promisify(execFile);

/** Levels, in the order they are printed. */
export const LEVELS = ['required', 'optional', 'later'];

/**
 * Config keys the plugin stopped reading, and what to say about each.
 *
 * A list rather than a chain of ifs because there will be more: `init` copies
 * the shipped file whole, so every key retired after somebody ran it lives on
 * in their config, indistinguishable from a setting they meant.
 */
export const RETIRED_KEYS = [
  {
    key: 'gates.require_states',
    why:
      'is no longer read (deleted in 0.6). The eligible states live in state.GATE_ELIGIBLE, keyed by push ' +
      'and reply — a config key could only widen them. Delete the key.',
  },
  {
    key: 'tools.rtk',
    why:
      'is no longer read (deleted in 0.18). The output rewriter was measured and dropped — it does not touch ' +
      'the commands this workflow spends its output on. The gate still unwraps `rtk git push` regardless of ' +
      'this key, so deleting it changes nothing except the impression that it is configured.',
  },
];

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {'required'|'optional'|'later'} level
 * @property {'ok'|'warn'|'fail'|'skip'} status
 * @property {string} detail
 */

/**
 * Run a command just to see whether it is there and working.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, stdout: string, error?: string}>}
 */
async function probe(command, args) {
  try {
    const { stdout } = await run(command, args, { encoding: 'utf8', timeout: 15000 });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: (error.stdout ?? '').trim(), error: error.code === 'ENOENT' ? 'not found' : error.message.split('\n')[0] };
  }
}

/**
 * @param {string} id
 * @param {'required'|'optional'|'later'} level
 * @param {'ok'|'warn'|'fail'|'skip'} status
 * @param {string} detail
 * @returns {Check}
 */
function check(id, level, status, detail) {
  return { id, level, status, detail };
}

/**
 * Required external tools.
 *
 * @param {number} minimumNode
 * @returns {Promise<Check[]>}
 */
async function checkTools(minimumNode) {
  const checks = [];

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push(
    major >= minimumNode
      ? check('node', 'required', 'ok', `${process.version}`)
      : check('node', 'required', 'fail', `${process.version}, need >= ${minimumNode}`),
  );

  for (const [id, command, args] of [
    ['git', 'git', ['--version']],
    ['pnpm', 'pnpm', ['--version']],
    ['gh', 'gh', ['--version']],
  ]) {
    const result = await probe(command, args);
    checks.push(
      result.ok
        ? check(id, 'required', 'ok', result.stdout.split('\n')[0])
        : check(id, 'required', 'fail', `${command}: ${result.error}`),
    );
  }

  const auth = await probe('gh', ['auth', 'status']);
  checks.push(
    auth.ok
      ? check('gh-auth', 'required', 'ok', 'authenticated')
      : check('gh-auth', 'required', 'fail', 'gh is not authenticated — run `gh auth login`'),
  );

  if (auth.ok) {
    // REST auth is not GraphQL auth. Review threads, their resolution state and
    // the reply mutation are GraphQL-only, and a token minted without the scope
    // fails at the one point where the failure is expensive: mid-sync, with
    // half the feedback read. Asking a trivial query costs one request.
    const graphql = await probe('gh', ['api', 'graphql', '-f', 'query=query { viewer { login } }']);
    checks.push(
      graphql.ok
        ? check('gh-graphql', 'required', 'ok', 'review threads are readable')
        : check(
            'gh-graphql',
            'required',
            'fail',
            `gh can authenticate but cannot query GraphQL, which is where review threads live: ${graphql.error}`,
          ),
    );
  }

  return checks;
}

/**
 * The configuration layers, and whether each one loads.
 *
 * @param {{repoRoot?: string, home: string}} options
 * @returns {Promise<Check[]>}
 */
async function checkConfig(options) {
  const checks = [];

  for (const layer of layers(options)) {
    try {
      await stat(layer.path);
    } catch {
      checks.push(
        layer.required
          ? check(`config:${layer.name}`, 'required', 'fail', `missing: ${layer.path}`)
          : check(`config:${layer.name}`, 'optional', 'skip', `not present: ${layer.path}`),
      );
      continue;
    }
    checks.push(check(`config:${layer.name}`, 'required', 'ok', layer.path));
  }

  try {
    const config = await load(options);
    checks.push(check('config:merge', 'required', 'ok', 'all present layers parse and merge'));

    // Keys nobody reads any more. `init` copies the whole shipped file, so a
    // key retired later survives in personal configs looking exactly like a
    // setting somebody chose — and in both cases below, looking like it does
    // something it has not done since the version named.
    const retired = RETIRED_KEYS.filter((entry) => get(config, entry.key) !== undefined);
    checks.push(
      retired.length === 0
        ? check('config:gates', 'optional', 'ok', 'no retired keys')
        : check('config:gates', 'optional', 'warn', retired.map((entry) => `${entry.key} ${entry.why}`).join(' ')),
    );
    checks.push(...(await checkPinnedArrays(options)));
  } catch (error) {
    checks.push(check('config:merge', 'required', 'fail', error.message));
  }

  return checks;
}

/**
 * Arrays a personal config copied from the defaults and then stopped tracking.
 *
 * Arrays replace wholesale rather than merging (lib/config.js), which is right:
 * a list the user edited must not be silently re-extended. The cost is that a
 * list they never edited — copied verbatim by `pdkit init` — freezes at the
 * shipped value of that day, and every later change to the default reaches
 * everyone except them.
 *
 * Found by running `pdkit knowledge check` on a real machine: the layer order
 * decision 27 extended in stage 3 had never taken effect here, because
 * $PDKIT_HOME/config.yaml still held the stage-0 copy. Nothing else could have
 * noticed — every command reads the merged value and it was a perfectly valid
 * list.
 *
 * @param {{repoRoot?: string, home?: string}} options
 * @returns {Promise<Check[]>}
 */
/**
 * Every dotted path in an object whose value is an array.
 *
 * @param {unknown} node
 * @param {string} [prefix]
 * @returns {string[]}
 */
function arrayPaths(node, prefix = '') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];

  const found = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) found.push(path);
    else found.push(...arrayPaths(value, path));
  }

  return found;
}

async function checkPinnedArrays(options) {
  const stale = [];

  let defaults;
  let effective;
  try {
    defaults = parse(await readFile(DEFAULTS_PATH, 'utf8'));
    effective = await load(options);
  } catch {
    return [check('config:arrays', 'optional', 'skip', 'the defaults or the merged configuration could not be read')];
  }

  // Every array in the defaults, not a list of four written down once. The
  // check said "no list has fallen behind the shipped defaults" while looking
  // at slicing.layer_order, quickfix.forbid_paths, validation-related lists and
  // worktrees.copy_files — so `review.bots_collapsed`, which had frozen at its
  // stage-0 value of [coderabbitai], passed it. codecov's comment was then
  // counted as a human's, on a real pull request. A check whose message is
  // wider than its measurement is the failure this plugin keeps finding in
  // itself; the fix is to make the measurement match the sentence.
  for (const path of arrayPaths(defaults)) {
    const shipped = get(defaults, path);
    const current = get(effective, path);

    if (!Array.isArray(shipped) || !Array.isArray(current)) continue;

    const missing = shipped.filter((entry) => !current.includes(entry));
    if (missing.length > 0) stale.push(`${path} is missing ${missing.join(', ')}`);
  }

  if (stale.length === 0) return [check('config:arrays', 'optional', 'ok', 'no list has fallen behind the shipped defaults')];

  return [
    check(
      'config:arrays',
      'optional',
      'warn',
      `${stale.join('; ')}. Arrays replace rather than merge, so a list copied by \`pdkit init\` and never edited ` +
        'stays at the value shipped that day. Delete the key to follow the default again, or extend it deliberately.',
    ),
  ];
}

/**
 * $PDKIT_HOME and everything `pdkit init` is supposed to have put in it.
 *
 * @param {string} home
 * @param {string|null} repoRoot
 * @returns {Promise<Check[]>}
 */
async function checkHome(home, repoRoot) {
  const layout = paths(home);
  const checks = [];

  try {
    await stat(layout.home);
    checks.push(check('home', 'required', 'ok', layout.home));
  } catch {
    return [check('home', 'required', 'fail', `${layout.home} does not exist — run \`pdkit init\``)];
  }

  let mapStat = null;
  try {
    mapStat = await stat(layout.packageMap);
    checks.push(check('package-map', 'required', 'ok', layout.packageMap));
  } catch {
    checks.push(check('package-map', 'required', 'fail', 'no package map — run `pdkit init`'));
  }

  // A map older than the workspace file describes packages that may no longer
  // exist. Not fatal — every command still runs — but every layer decision it
  // feeds is made from a stale list.
  if (mapStat && repoRoot) {
    try {
      const workspace = await stat(join(repoRoot, 'pnpm-workspace.yaml'));
      checks.push(
        workspace.mtimeMs <= mapStat.mtimeMs
          ? check('package-map:fresh', 'required', 'ok', 'newer than pnpm-workspace.yaml')
          : check('package-map:fresh', 'optional', 'warn', 'pnpm-workspace.yaml changed since the map was built — run `pdkit init`'),
      );
    } catch {
      checks.push(check('package-map:fresh', 'required', 'fail', 'the repository has no pnpm-workspace.yaml'));
    }
  }

  if (mapStat) {
    const map = JSON.parse(await readFile(layout.packageMap, 'utf8'));
    const unclaimed = Object.entries(map.packages)
      .filter(([, entry]) => entry.layer === UNKNOWN_LAYER)
      .map(([name]) => name);

    // Naming the file that decides the list is the point of the second line.
    // `pdkit init` copies the whole defaults file into $PDKIT_HOME, so a
    // layer_order the plugin has since extended goes on being shadowed by that
    // copy — and the warning then looks like a defect in the shipped defaults.
    const source = definedIn('slicing.layer_order', { repoRoot: repoRoot ?? undefined, home: layout.home });

    checks.push(
      unclaimed.length === 0
        ? check('package-map:layers', 'optional', 'ok', 'every package belongs to a layer')
        : check(
            'package-map:layers',
            'optional',
            'warn',
            `no layer claims ${unclaimed.join(', ')} — extend slicing.layer_order in ${source?.path ?? 'the config'} ` +
              'and re-run `pdkit init`, or accept that the merge order of those packages is decided by nothing',
          ),
    );
  }

  return checks;
}

/**
 * Working trees: where they go, and whether git still believes in them.
 *
 * Slice verification builds in one of these, so a root that cannot be written
 * or a tree git has lost track of turns into a verification failure that looks
 * like a failing slice. Worth a line in the report rather than a surprise mid
 * flow.
 *
 * @param {{repoRoot: string|null, config: import('./config.js').Config}} options
 * @returns {Promise<Check[]>}
 */
async function checkWorktrees(options) {
  if (!options.repoRoot) return [];

  const root = await rootFor({ repoRoot: options.repoRoot, config: options.config });
  const checks = [];

  // Checked, not created. A diagnostic that makes the thing it is diagnosing
  // reports on its own side effects, and the first time this ran it left an
  // empty directory in a workspace nobody asked it to touch.
  try {
    await access(root, FS.W_OK);
    checks.push(check('worktrees:root', 'optional', 'ok', root));
  } catch {
    try {
      await access(dirname(root), FS.W_OK);
      checks.push(check('worktrees:root', 'optional', 'ok', `${root} (not there yet; the parent is writable)`));
    } catch (error) {
      checks.push(check('worktrees:root', 'optional', 'warn', `cannot write ${root} (${error.code ?? error.message})`));
      return checks;
    }
  }

  const trees = await listWorktrees(options.repoRoot);
  const missing = [];
  for (const tree of trees.filter((entry) => !entry.main)) {
    try {
      await access(tree.path);
    } catch {
      missing.push(tree.path);
    }
  }

  checks.push(
    missing.length === 0
      ? check('worktrees:registered', 'optional', 'ok', `${trees.length} tree(s), all present`)
      : check(
          'worktrees:registered',
          'optional',
          'warn',
          `git lists ${missing.length} tree(s) that are not on disk (${missing.join(', ')}) — run \`git worktree prune\``,
        ),
  );

  return checks;
}

/**
 * The repository this run would act on.
 *
 * @param {{cwd?: string, config: import('./config.js').Config}} options
 * @returns {Promise<{checks: Check[], root: string|null}>}
 */
async function checkRepo(options) {
  const repo = await resolveRepoRoot(options);

  if (!repo.root) {
    return { checks: [check('repo', 'required', 'fail', repo.problems.join('; '))], root: null };
  }
  if (!repo.matches) {
    return {
      checks: [check('repo', 'required', 'fail', `${repo.root}: ${repo.problems.join('; ')}`)],
      root: repo.root,
    };
  }

  return { checks: [check('repo', 'required', 'ok', `${repo.root} (${Object.keys(repo.remotes).join(', ')})`)], root: repo.root };
}

/**
 * hooks.json against the handlers it names.
 *
 * @param {string} pluginRoot
 * @returns {Promise<Check[]>}
 */
async function checkHooks(pluginRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  } catch (error) {
    return [check('hooks', 'required', 'fail', `hooks/hooks.json: ${error.message}`)];
  }

  const problems = [];
  let registered = 0;

  for (const entries of Object.values(manifest.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        registered += 1;
        const event = hook.args?.[1];
        if (!event) problems.push(`a hook entry has no event argument`);
        else if (!(event in HOOK_HANDLERS)) problems.push(`"${event}" has no handler`);
        else {
          try {
            await stat(join(pluginRoot, 'lib', 'hooks', HOOK_HANDLERS[event]));
          } catch {
            problems.push(`${event} -> lib/hooks/${HOOK_HANDLERS[event]} is missing`);
          }
        }
      }
    }
  }

  return [
    problems.length === 0
      ? check('hooks', 'required', 'ok', `${registered} entries, every event has a handler`)
      : check('hooks', 'required', 'fail', problems.join('; ')),
  ];
}

/**
 * MCP servers the config expects, against what the CLI reports.
 *
 * The plugin ships no .mcp.json on purpose (section 8), so this is a check on
 * the user's own session configuration and it degrades to "cannot tell"
 * rather than guessing.
 *
 * @param {import('./config.js').Config} config
 * @returns {Promise<Check[]>}
 */
async function checkMcp(config) {
  const expected = /** @type {Record<string, string>} */ (get(config, 'mcp') ?? {});
  const wanted = Object.entries(expected).filter(([, mode]) => mode !== 'off' && mode !== false);
  if (wanted.length === 0) return [check('mcp', 'optional', 'skip', 'no servers expected by config')];

  const listed = await probe('claude', ['mcp', 'list']);
  if (!listed.ok && listed.stdout === '') {
    return [check('mcp', 'optional', 'skip', `cannot tell: ${listed.error}`)];
  }

  const present = new Set(
    listed.stdout
      .split('\n')
      .map((line) => line.split(':')[0].trim().toLowerCase())
      .filter(Boolean),
  );

  /** What stops working without each server, so the report is actionable. */
  const degrades = {
    playwright:
      '/pd:validate produces a checklist instead of a run and never sets PASS. ' +
      'Configure it with --cdp-endpoint: pdkit starts the application, the server attaches to it',
    context7: 'library documentation lookups fall back to the model’s own knowledge',
    basic_memory: 'notes are not written to the vault',
    github: 'PR data comes from the gh CLI only',
  };

  return wanted.map(([name, mode]) => {
    const key = name.replaceAll('_', '-');
    const found = present.has(key) || present.has(name);
    if (found) return check(`mcp:${name}`, 'optional', 'ok', 'connected');
    return check(
      `mcp:${name}`,
      'optional',
      mode === 'on' ? 'warn' : 'skip',
      `not configured — ${degrades[name] ?? 'the features that use it are unavailable'}`,
    );
  });
}

/**
 * Whether there is an application to validate against.
 *
 * "No Playwright" and "nothing to point Playwright at" are different problems
 * with different fixes, and the second is the one that is invisible: the MCP
 * server can be perfectly configured and /pd:validate still has nothing to
 * drive, because the working tree was never built.
 *
 * @param {{repoRoot: string|null, config: object}} options
 * @returns {Promise<Check[]>}
 */
async function checkValidationTarget(options) {
  if (!options.repoRoot) return [check('validate:app', 'optional', 'skip', 'no repository to look in')];

  const configured = String(get(options.config, 'validation.app.binary') ?? '').trim();
  const fromEnv = String(process.env.PODMAN_DESKTOP_BINARY ?? '').trim();

  for (const [source, path] of [
    ['validation.app.binary', configured],
    ['PODMAN_DESKTOP_BINARY', fromEnv],
  ]) {
    if (!path) continue;
    try {
      await access(path, FS.X_OK);
      return [check('validate:app', 'optional', 'ok', `${path} (${source})`)];
    } catch {
      return [check('validate:app', 'optional', 'warn', `${source} points at ${path}, which is not executable here`)];
    }
  }

  const electron = join(options.repoRoot, 'node_modules', '.bin', 'electron');
  try {
    await access(electron, FS.X_OK);
  } catch {
    return [
      check(
        'validate:app',
        'optional',
        'warn',
        'no packaged binary and no node_modules/.bin/electron — install dependencies, or /pd:validate has nothing to drive',
      ),
    ];
  }

  // Electron is there, but `electron .` runs whatever the last build left. An
  // unbuilt tree starts and shows nothing, which looks like a broken
  // application rather than a missing step.
  try {
    await access(join(options.repoRoot, 'packages', 'main', 'dist'));
    return [check('validate:app', 'optional', 'ok', 'node_modules/.bin/electron ., and the tree has been built')];
  } catch {
    return [
      check('validate:app', 'optional', 'warn', 'electron is installed but the tree has no build output — run the build, or `pdkit validate launch --build`'),
    ];
  }
}

/**
 * Global ponytail hooks (section 8.1).
 *
 * Not a breakage, but an invisible source of divergence between the plan and
 * the implementation, and knowing about it is the whole point.
 *
 * @returns {Promise<Check[]>}
 */
async function checkPonytailHooks() {
  const file = join(homedir(), '.claude', 'settings.json');

  let settings;
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [check('ponytail:hooks', 'optional', 'skip', 'no user settings.json')];
    return [check('ponytail:hooks', 'optional', 'skip', `${file}: ${error.message}`)];
  }

  const serialized = JSON.stringify(settings.hooks ?? {});
  return [
    serialized.includes('ponytail')
      ? check('ponytail:hooks', 'optional', 'warn', `${file} registers ponytail hooks globally — they run outside pdkit's view (section 8.1)`)
      : check('ponytail:hooks', 'optional', 'ok', 'no global ponytail hooks'),
  ];
}

/**
 * Commands the gate must refuse, and commands it must not.
 *
 * Both halves matter. A gate that refuses everything is as broken as one that
 * refuses nothing — it just fails in the direction where somebody turns it off.
 *
 * The deny list is every shape of `git push` that has ever been a way past a
 * substring match, the wrapped form included.
 */
export const GATE_PROBES = [
  { command: 'git push', deny: true, why: 'the bare form' },
  { command: 'git push --force origin main', deny: true, why: 'force, refused unconditionally' },
  // The plugin configures no rewriter and recommends none (section 8.2), which
  // is not the same as there being none installed. `rtk` is a real program
  // somebody may have on PATH for another project, and a global hook of its
  // kind rewrites commands in every project at once.
  { command: 'rtk git push', deny: true, why: 'wrapped by a rewriter' },
  { command: 'pnpm test:unit && git push', deny: true, why: 'chained' },
  { command: '(git push)', deny: true, why: 'in a subshell' },
  { command: 'echo $(git push)', deny: true, why: 'in a substitution' },
  { command: '/usr/bin/git push', deny: true, why: 'named by path' },
  { command: 'git add -A', deny: true, why: 'blanket staging' },
  { command: 'git commit --no-verify -m x', deny: true, why: 'skipping the hooks' },
  { command: 'git rebase -i main', deny: true, why: 'interactive rebase' },
  { command: 'gh pr create --base main --head x --title t', deny: true, why: 'opening a pull request' },
  { command: 'gh pr review 17577 --approve', deny: true, why: 'writing to an open pull request' },
  { command: 'gh pr comment 17577 --body x', deny: true, why: 'replying without a reply token' },
  { command: 'gh issue comment 17221 --body x', deny: true, why: 'writing to the tracker, which no state allows' },
  {
    command: 'gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \\"x\\"}) { thread { id } } }"',
    deny: true,
    why: 'a mutation naming no pull request',
  },

  { command: 'git status', deny: false, why: 'reading' },
  { command: 'git add packages/main/src/x.ts', deny: false, why: 'staging an explicit path' },
  { command: 'git commit -m "fix(main): x"', deny: false, why: 'an ordinary commit' },
  { command: 'gh pr view 1', deny: false, why: 'reading a pull request' },
  { command: 'gh api repos/o/r', deny: false, why: 'reading through the API' },
  { command: 'pnpm test:unit', deny: false, why: 'running tests' },
];

/**
 * Feed one command to the hook exactly as Claude Code would.
 *
 * @param {{command: string, args: string[], commandLine: string, env: Record<string, string>}} input
 * @returns {Promise<number>} exit code
 */
function probeHook(input) {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      env: { ...process.env, ...input.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: input.commandLine } }));
  });
}

/**
 * Exercise the push gate through the hook the manifest registers.
 *
 * Spawning the registered binary rather than importing the handler is the
 * whole point: this is the one check where "the code is correct" is not the
 * question. What is being tested is that the hook Claude Code will actually
 * run sees the command — a manifest pointing at the wrong file, a matcher on
 * the wrong tool, or a handler that stopped loading all produce a plugin that
 * looks installed and gates nothing.
 *
 * Runs against a throwaway $PDKIT_HOME. A real token for the current branch
 * would make `git push` legitimately allowed, which would read as a failure
 * here and would burn the token on a test.
 *
 * @param {{pluginRoot: string}} options
 * @returns {Promise<Check[]>}
 */
export async function gateSelftest(options) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(options.pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  } catch (error) {
    return [check('gate:selftest', 'required', 'fail', `hooks/hooks.json: ${error.message}`)];
  }

  const entry = (manifest.hooks?.PreToolUse ?? []).find((item) => item.matcher === 'Bash');
  const hook = entry?.hooks?.[0];
  if (!hook?.command) {
    return [
      check('gate:selftest', 'required', 'fail', 'hooks.json registers no PreToolUse hook on Bash — nothing guards writes'),
    ];
  }

  const expand = (text) => String(text).replaceAll('${CLAUDE_PLUGIN_ROOT}', options.pluginRoot);
  const command = expand(hook.command);
  const args = (hook.args ?? []).map(expand);

  const home = await mkdtemp(join(tmpdir(), 'pdkit-selftest-'));
  const missed = [];
  const overblocked = [];

  try {
    for (const probe of GATE_PROBES) {
      const code = await probeHook({ command, args, commandLine: probe.command, env: { PDKIT_HOME: home } });
      const blocked = code === 2;

      if (probe.deny && !blocked) missed.push(`${probe.command}  (${probe.why}) — exit ${code}`);
      if (!probe.deny && blocked) overblocked.push(`${probe.command}  (${probe.why})`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const denies = GATE_PROBES.filter((probe) => probe.deny).length;
  const allows = GATE_PROBES.length - denies;

  return [
    ...(await ownsSelftest({ manifest, pluginRoot: options.pluginRoot })),
    missed.length === 0
      ? check('gate:selftest', 'required', 'ok', `${denies} forbidden commands all refused, through ${command}`)
      : check(
          'gate:selftest',
          'required',
          'fail',
          `THE GATE DOES NOT SEE ${missed.length} of ${denies} forbidden commands:\n      ${missed.join('\n      ')}`,
        ),
    overblocked.length === 0
      ? check('gate:allows', 'required', 'ok', `${allows} ordinary commands all allowed`)
      : check(
          'gate:allows',
          'required',
          'fail',
          `refuses ordinary work, which is how a gate gets switched off:\n      ${overblocked.join('\n      ')}`,
        ),
  ];
}

/**
 * Exercise the ownership hook through the manifest, the same way.
 *
 * Same argument as the gate: the failure worth catching is not a wrong
 * decision, it is a hook that is never asked. A matcher naming the wrong tool
 * or a handler that stopped loading leaves the ownership map looking enforced
 * while every write goes through.
 *
 * @param {{manifest: object, pluginRoot: string}} options
 * @returns {Promise<Check[]>}
 */
async function ownsSelftest(options) {
  const entry = (options.manifest.hooks?.PreToolUse ?? []).find((item) => /Write/.test(String(item.matcher ?? '')));
  const hook = entry?.hooks?.[0];
  if (!hook?.command) {
    return [check('owns:selftest', 'required', 'fail', 'hooks.json registers no PreToolUse hook on Write — the ownership map is advisory')];
  }

  const expand = (text) => String(text).replaceAll('${CLAUDE_PLUGIN_ROOT}', options.pluginRoot);
  const home = await mkdtemp(join(tmpdir(), 'pdkit-owns-selftest-'));
  const repo = await mkdtemp(join(tmpdir(), 'pdkit-owns-selftest-repo-'));

  try {
    const tree = await realpath(repo);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: tree });
    await mkdir(join(tree, 'owned'), { recursive: true });
    await mkdir(join(tree, 'other'), { recursive: true });

    await setOwns(4242, 'T1', ['owned/**'], { home });
    await startTask({ issue: 4242, taskId: 'T1', worktree: tree, home });

    /**
     * @param {string} file
     * @returns {Promise<number>}
     */
    const probe = (file) =>
      new Promise((resolve) => {
        const child = spawn(expand(hook.command), (hook.args ?? []).map(expand), {
          env: { ...process.env, PDKIT_HOME: home },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(code ?? -1));
        child.stdin.end(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(tree, file) }, cwd: tree }));
      });

    const outside = await probe('other/x.ts');
    const inside = await probe('owned/x.ts');

    if (outside !== 2) {
      return [check('owns:selftest', 'required', 'fail', `a write outside the active task's files was allowed (exit ${outside}) — the ownership map is not enforced`)];
    }
    if (inside === 2) {
      return [check('owns:selftest', 'required', 'fail', 'a write to an owned file was refused, which is how a hook gets switched off')];
    }

    return [check('owns:selftest', 'required', 'ok', 'writes outside the active task are refused, writes inside are not')];
  } catch (error) {
    return [check('owns:selftest', 'required', 'fail', `could not be run: ${error.message}`)];
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
}

/**
 * Run every check.
 *
 * @param {{cwd?: string, home?: string, pluginRoot: string, gateSelftest?: boolean}} options
 * @returns {Promise<{status: 'ok'|'warn'|'fail', checks: Check[], home: string, repo: string|null}>}
 */
export async function diagnose(options) {
  const cwd = options.cwd;
  const engines = JSON.parse(await readFile(join(options.pluginRoot, 'package.json'), 'utf8')).engines ?? {};
  const minimumNode = Number.parseInt(String(engines.node ?? '>=22').replace(/[^\d]/g, ''), 10);

  /** @type {Check[]} */
  const checks = [...(await checkTools(minimumNode))];

  let config = {};
  try {
    config = await load({ repoRoot: cwd });
  } catch {
    // checkConfig reports it; carrying on with an empty config keeps the rest
    // of the report useful instead of ending it at the first bad file.
  }

  const repo = await checkRepo({ cwd, config });
  checks.push(...repo.checks);

  const home = options.home ?? resolveHome({ repoRoot: repo.root ?? undefined });

  // Reloaded now that the home is known. The first load could not name it —
  // it runs before the repository is resolved — so every check after this one
  // would otherwise read a config missing its middle layer, and report on
  // settings the user does not actually have.
  try {
    config = await load({ repoRoot: repo.root ?? undefined, home });
  } catch {
    // Already reported by checkConfig below.
  }

  checks.push(...(await checkConfig({ repoRoot: repo.root ?? undefined, home })));
  checks.push(...(await checkHome(home, repo.root)));
  checks.push(...(await checkWorktrees({ repoRoot: repo.root, config })));
  checks.push(...(await checkHooks(options.pluginRoot)));
  checks.push(...(await checkMcp(config)));
  checks.push(...(await checkValidationTarget({ repoRoot: repo.root ?? null, config })));
  checks.push(...(await checkPonytailHooks()));

  if (options.gateSelftest) {
    checks.push(...(await gateSelftest({ pluginRoot: options.pluginRoot })));
  } else {
    // Not run by default: it spawns the hook once per probe, which is slower
    // than every other check here put together. Named rather than omitted, so
    // "I ran doctor" does not quietly mean "I did not check the gate".
    checks.push(
      check('gate:selftest', 'optional', 'skip', 'run `pdkit doctor --gate-selftest` — it spawns the hook once per probe'),
    );
  }

  const failed = checks.some((entry) => entry.level === 'required' && entry.status === 'fail');
  const warned = checks.some((entry) => entry.status === 'warn');

  return { status: failed ? 'fail' : warned ? 'warn' : 'ok', checks, home, repo: repo.root };
}

/** Symbols, chosen so the report is readable without colour. */
const MARK = { ok: '✔', warn: '!', fail: '✘', skip: '·' };

/**
 * Render a report for a terminal.
 *
 * @param {Awaited<ReturnType<typeof diagnose>>} report
 * @param {{version: string}} meta
 * @returns {string}
 */
export function format(report, meta) {
  const lines = [`pdkit ${meta.version} — ${report.status}`, ''];

  for (const level of LEVELS) {
    const group = report.checks.filter((entry) => entry.level === level);
    if (group.length === 0) continue;

    lines.push(`${level}:`);
    for (const entry of group) {
      lines.push(`  ${MARK[entry.status]} ${entry.id.padEnd(22)} ${entry.detail}`);
    }
    lines.push('');
  }

  if (report.status === 'fail') lines.push('Fix the ✘ items above; the rest of pdkit assumes them.');

  return `${lines.join('\n')}\n`;
}

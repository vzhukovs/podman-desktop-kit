// SPDX-License-Identifier: Apache-2.0

// The environment check behind `/pd:doctor`.
//
// Two rules shape every check here. Nothing is reported as available without
// being exercised — a doctor that trusts a config file tells the user what
// they wrote, not what they have. And a missing optional dependency is
// reported together with what degrades because of it: "no Playwright" is not
// actionable, "no Playwright, so /pd:validate produces a checklist and never
// sets PASS" is.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { get, layers, load, paths, resolveHome } from './config.js';
import { HOOK_HANDLERS } from './hooks/events.js';
import { UNKNOWN_LAYER, resolveRepoRoot } from './repo.js';

const run = promisify(execFile);

/** Levels, in the order they are printed. */
export const LEVELS = ['required', 'optional', 'later'];

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
    await load(options);
    checks.push(check('config:merge', 'required', 'ok', 'all present layers parse and merge'));
  } catch (error) {
    checks.push(check('config:merge', 'required', 'fail', error.message));
  }

  return checks;
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

    checks.push(
      unclaimed.length === 0
        ? check('package-map:layers', 'optional', 'ok', 'every package belongs to a layer')
        : check(
            'package-map:layers',
            'optional',
            'warn',
            `no layer claims ${unclaimed.join(', ')} — add them to slicing.layer_order or accept that slice order ignores them`,
          ),
    );
  }

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
    playwright: '/pd:validate produces a checklist instead of a run and never sets PASS',
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
 * Run every check.
 *
 * @param {{cwd?: string, home?: string, pluginRoot: string}} options
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
  checks.push(...(await checkConfig({ repoRoot: repo.root ?? undefined, home })));
  checks.push(...(await checkHome(home, repo.root)));
  checks.push(...(await checkHooks(options.pluginRoot)));
  checks.push(...(await checkMcp(config)));
  checks.push(...(await checkPonytailHooks()));

  checks.push(
    check('gate:selftest', 'later', 'skip', 'the push gate lands in stage 1; --gate-selftest checks it then'),
    check('rtk:readonly', 'later', 'skip', 'rtk is enabled after the gate exists and is verified (section 8.2)'),
  );

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

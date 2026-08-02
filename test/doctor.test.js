// SPDX-License-Identifier: Apache-2.0

// Tests for the gate self-test in lib/doctor.js.
//
// This is the check that answers "is the gate actually on", so the thing worth
// asserting is that it can say no. A self-test that only ever passes is
// indistinguishable from one that does nothing, and this particular one would
// be reassuring while the plugin gated nothing at all.
//
// It runs against a copy of the plugin, so breaking the gate to prove the
// check notices does not mean editing the plugin under the test runner.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, commitAll, initRepo } from './helpers/repo-fixture.js';
import { GATE_PROBES, diagnose, gateSelftest, rtkExcludedCommands, rtkHookInstalled } from '../lib/doctor.js';
import { create } from '../lib/worktree.js';

let plugin;

const find = (checks, id) => checks.find((entry) => entry.id === id);

before(async () => {
  plugin = await mkdtemp(join(tmpdir(), 'pdkit-doctor-'));

  for (const entry of ['bin', 'lib', 'hooks', 'defaults', 'templates', 'package.json']) {
    await cp(join(process.cwd(), entry), join(plugin, entry), { recursive: true });
  }
});

after(async () => {
  await rm(plugin, { recursive: true, force: true });
});

describe('the probe set', () => {
  // Both halves. A gate that refuses everything fails in the direction where
  // somebody switches it off, which is worse than one that is merely noisy.
  test('covers both refusals and ordinary work', () => {
    const denies = GATE_PROBES.filter((probe) => probe.deny);
    const allows = GATE_PROBES.filter((probe) => !probe.deny);

    assert.ok(denies.length >= 8, 'too few forbidden shapes to be worth running');
    assert.ok(allows.length >= 4, 'without these, a gate that blocks everything looks healthy');
    for (const probe of GATE_PROBES) assert.ok(probe.why, `${probe.command} has no explanation`);
  });

  // Section 8.2: a rewriter must not become a way past the gate, and the ways
  // past a naive matcher are the ones worth probing.
  test('includes the shapes that defeat substring matching', () => {
    const commands = GATE_PROBES.filter((probe) => probe.deny).map((probe) => probe.command);

    assert.ok(commands.some((c) => c.startsWith('rtk ')), 'no wrapped form');
    assert.ok(commands.some((c) => c.includes('&&')), 'no chained form');
    assert.ok(commands.some((c) => c.startsWith('(')), 'no subshell form');
    assert.ok(commands.some((c) => c.includes('$(')), 'no substitution form');
    assert.ok(commands.some((c) => c.startsWith('/')), 'no path form');
  });
});

describe('the self-test', () => {
  test('passes on an intact plugin', async () => {
    const checks = await gateSelftest({ pluginRoot: plugin });

    assert.equal(find(checks, 'gate:selftest').status, 'ok');
    assert.equal(find(checks, 'gate:allows').status, 'ok');
  });

  test('fails when the manifest does not register the hook on Bash', async () => {
    const file = join(plugin, 'hooks', 'hooks.json');
    const original = await readFile(file, 'utf8');
    const manifest = JSON.parse(original);
    manifest.hooks.PreToolUse[0].matcher = 'Read';
    await writeFile(file, JSON.stringify(manifest));

    try {
      const checks = await gateSelftest({ pluginRoot: plugin });
      const result = find(checks, 'gate:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /no PreToolUse hook on Bash/);
    } finally {
      await writeFile(file, original);
    }
  });

  // The failure this whole check exists for: the plugin is installed, the
  // hooks load, and a push goes through anyway.
  test('names each forbidden command the gate stopped seeing', async () => {
    const file = join(plugin, 'lib', 'hooks', 'rules.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace(/ {2}\{\n {4}id: 'push',[\s\S]*?\n {2}\},\n/, ''));

    try {
      const result = find(await gateSelftest({ pluginRoot: plugin }), 'gate:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /THE GATE DOES NOT SEE/);
      assert.match(result.detail, /rtk git push/);
      assert.match(result.detail, /\(git push\)/);
    } finally {
      await writeFile(file, original);
    }
  });

  test('the ownership hook is exercised through the manifest too', async () => {
    assert.equal(find(await gateSelftest({ pluginRoot: plugin }), 'owns:selftest').status, 'ok');
  });

  // Same failure as the gate's, one hook across: the map looks enforced and
  // every write goes through.
  test('names it when a write outside the active task is allowed', async () => {
    const file = join(plugin, 'lib', 'hooks', 'owns.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('export async function handle(payload, _context) {', 'export async function handle(payload, _context) {\n  return { block: false };'));

    try {
      const result = find(await gateSelftest({ pluginRoot: plugin }), 'owns:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /ownership map is not enforced/);
    } finally {
      await writeFile(file, original);
    }
  });

  test('fails the other way when the gate refuses ordinary work', async () => {
    const file = join(plugin, 'lib', 'hooks', 'dispatch.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'this is not valid javascript {{{\n');

    try {
      const checks = await gateSelftest({ pluginRoot: plugin });

      // pre-bash fails closed, so a broken handler blocks everything. That is
      // the intended behaviour, and it is still a broken gate.
      assert.equal(find(checks, 'gate:allows').status, 'fail');
      assert.match(find(checks, 'gate:allows').detail, /git status/);
    } finally {
      await writeFile(file, original);
    }
  });
});

// Slice verification builds in a worktree, so a root that cannot be written or
// a tree git has lost track of becomes a verification failure that looks like a
// failing slice.
describe('the worktree checks', () => {
  let repo;
  let home;

  before(async () => {
    repo = await initRepo('pdkit-doctor-worktree-');
    home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-worktree-home-'));

    await writeFile(join(repo, 'file.txt'), 'x\n');
    await writeFile(join(repo, '.pdkit.yaml'), `worktrees:\n  root: ${join(repo, '..', 'doctor-trees')}\n`);
    await commitAll(repo, 'chore: seed');
  });

  after(async () => {
    await cleanup(repo, home, join(repo, '..', 'doctor-trees'));
  });

  test('a root that does not exist yet is fine, and is not created by asking', async () => {
    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd() });
    const root = find(report.checks, 'worktrees:root');

    assert.equal(root.status, 'ok');
    assert.match(root.detail, /not there yet/);
    await assert.rejects(access(join(repo, '..', 'doctor-trees')), 'diagnosing must not create what it is diagnosing');
  });

  test('a tree git lists but disk does not have is a warning with the fix in it', async () => {
    await create({ repoRoot: repo, name: 'ghost', config: { worktrees: { root: join(repo, '..', 'doctor-trees') }, repo: { base_branch: 'main' } }, home });
    await rm(join(repo, '..', 'doctor-trees', 'ghost'), { recursive: true, force: true });

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd() });
    const registered = find(report.checks, 'worktrees:registered');

    assert.equal(registered.status, 'warn');
    assert.match(registered.detail, /git worktree prune/);
  });
});

// Two checks that exist because of what a real run found. The first is the
// drift `pdkit knowledge check` uncovered on this machine: an array copied by
// `pdkit init` at stage 0 was still pinning the stage-0 value, so a decision
// taken two stages later had never taken effect here — and nothing could have
// noticed, because the merged value was a perfectly valid list.
describe('the validation and config-drift checks', () => {
  let repo;
  let home;

  before(async () => {
    repo = await initRepo('pdkit-doctor-validate-');
    home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-validate-home-'));

    await writeFile(join(repo, 'file.txt'), 'x\n');
    await commitAll(repo, 'chore: seed');
  });

  after(async () => {
    await cleanup(repo, home);
  });

  test('a list that has fallen behind the shipped default is named, with the missing entries', async () => {
    await writeFile(join(home, 'config.yaml'), 'slicing:\n  layer_order: [extension-api, main, tests]\n');

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd() });
    const arrays = find(report.checks, 'config:arrays');

    assert.equal(arrays.status, 'warn');
    assert.match(arrays.detail, /slicing\.layer_order is missing/);
    assert.match(arrays.detail, /Arrays replace rather than merge/);
  });

  test('a config that pins nothing is not warned about', async () => {
    await writeFile(join(home, 'config.yaml'), 'repo:\n  base_branch: main\n');

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd() });

    assert.equal(find(report.checks, 'config:arrays').status, 'ok');
  });

  test('nothing to drive is reported as its own problem, not as a missing Playwright', async () => {
    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd() });
    const app = find(report.checks, 'validate:app');

    assert.equal(app.status, 'warn');
    assert.match(app.detail, /nothing to drive|no packaged binary/);
    assert.equal(app.level, 'optional', 'an unbuilt tree does not stop the rest of the plugin working');
  });

  test('a configured binary that is not executable is a warning that names the source', async () => {
    await writeFile(join(home, 'config.yaml'), `validation:\n  app:\n    binary: ${join(repo, 'not-executable')}\n`);
    await writeFile(join(repo, 'not-executable'), 'x\n');

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd() });
    const app = find(report.checks, 'validate:app');

    assert.equal(app.status, 'warn');
    assert.match(app.detail, /validation\.app\.binary points at/);
  });
});

// Section 8.2. Both of these were reported green while being wrong on a real
// machine: rtk was installed with no hook, so it compressed nothing and saved
// nothing, and the exclusion list had been written to ~/.config/rtk/ while rtk
// 0.44.0 on macOS reads ~/Library/Application Support/rtk/ — so `git push`,
// `git commit` and `gh pr` were all being rewritten while the check said they
// were excluded. Both are parsed from rtk's own answers now.
describe('reading what rtk says about itself', () => {
  // Verbatim from `rtk init --show` 0.44.0 with nothing installed.
  const INERT = [
    '[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings',
    'rtk Configuration:',
    '',
    '[--] Hook: not found',
    '[--] RTK.md: not found',
    '[warn] settings.json: exists but RTK hook not configured',
  ].join('\n');

  const ACTIVE = ['rtk Configuration:', '', '[ok] Hook: ~/.claude/hooks/rtk-rewrite.sh', '[ok] RTK.md: ~/.claude/RTK.md'].join('\n');

  test('an installed hook and an absent one are told apart', () => {
    assert.equal(rtkHookInstalled(ACTIVE), true);
    assert.equal(rtkHookInstalled(INERT), false);
  });

  // The whole point of the rewrite. "I could not tell" must not read as "yes",
  // because that is precisely how the old check stayed green.
  test('an unreadable answer is null, never true', () => {
    assert.equal(rtkHookInstalled('some future format nobody here has seen'), null);
    assert.equal(rtkHookInstalled(''), null);
  });

  test('the exclusion list is read from what rtk reports as effective', () => {
    const config = [
      'Config: /Users/someone/Library/Application Support/rtk/config.toml',
      '',
      '[hooks]',
      'exclude_commands = [',
      '    "git push",',
      '    "git commit",',
      ']',
    ].join('\n');

    assert.deepEqual(rtkExcludedCommands(config), ['git push', 'git commit']);
  });

  test('an empty list is a list, and no block at all is not', () => {
    assert.deepEqual(rtkExcludedCommands('[hooks]\nexclude_commands = []'), []);
    assert.equal(rtkExcludedCommands('[hooks]\ntransparent_prefixes = []'), null);
  });
});

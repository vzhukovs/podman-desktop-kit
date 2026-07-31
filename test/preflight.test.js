// SPDX-License-Identifier: Apache-2.0

// Tests for lib/preflight — the runner, script scoping, and the checks that
// run commands.
//
// The property that matters most is that preflight cannot be green by
// accident. A check that could not run, a script that no longer exists, a test
// command that was killed — each of those has a way of looking like a pass, and
// each is asserted here to look like what it is instead.
//
// Commands run against a fixture repository with npm scripts that echo and
// exit, so the checks are exercised for real rather than mocked.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CHECK_IDS, format, loadChecks, prepare, run } from '../lib/preflight/index.js';
import { candidatesFor, runScript, scopedScripts } from '../lib/preflight/scope.js';
import { buildPackageMap } from '../lib/repo.js';

const execFileAsync = promisify(execFile);

let repo;
let home;

const SCRIPTS = {
  'lint:check': 'echo linted',
  'test:main': 'echo main tests ok',
  'test:unit': 'echo all unit tests ok',
  'test:renderer': 'echo renderer failed 1>&2 && exit 1',
  typecheck: 'echo typechecked',
};

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pdkit-preflight-repo-'));
  home = await mkdtemp(join(tmpdir(), 'pdkit-preflight-home-'));

  const git = (args) => execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });

  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'root', scripts: SCRIPTS }, null, 2));
  await writeFile(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(repo, '.pdkit.yaml'), 'repo:\n  package_manager: npm\n');

  for (const [dir, name] of [
    ['packages/main', '@podman-desktop/main'],
    ['packages/renderer', 'renderer'],
  ]) {
    await mkdir(join(repo, dir, 'src'), { recursive: true });
    await writeFile(join(repo, dir, 'package.json'), JSON.stringify({ name }));
  }

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'packages/main/src/base.ts'), 'export const base = 1;\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'chore: base']);

  await git(['checkout', '-q', '-b', 'DESKTOP-5001/work']);
  await writeFile(join(repo, 'packages/main/src/added.ts'), 'export const added = 1;\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'feat(main): add\n\nSigned-off-by: Test <test@example.com>']);

  await buildPackageMap(repo, {
    home,
    config: { slicing: { layer_order: ['main', 'renderer'] } },
  });
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** @returns {Promise<import('../lib/preflight/index.js').PreflightContext>} */
const context = (overrides = {}) => prepare({ issue: 5001, repoRoot: repo, home, ...overrides });

describe('the runner', () => {
  test('loads a module for every declared check', async () => {
    const checks = await loadChecks();

    assert.equal(checks.length, CHECK_IDS.length);
    assert.deepEqual(checks.map((check) => check.id), CHECK_IDS);
    for (const check of checks) assert.equal(typeof check.run, 'function', `${check.id} has no run()`);
  });

  test('prepare gathers the repository state once, for every check', async () => {
    const prepared = await context();

    assert.equal(prepared.branch, 'DESKTOP-5001/work');
    assert.equal(prepared.base, 'main');
    assert.deepEqual(prepared.changedFiles, ['packages/main/src/added.ts']);
    assert.equal(prepared.commits.length, 1);
    assert.ok('lint:check' in prepared.scripts);
    assert.equal(prepared.prBody, null);
  });

  // A report listing three problems is one round trip; three reports of one
  // problem each are three.
  test('every check runs even after one fails', async () => {
    const report = await run(await context());

    assert.equal(report.results.length, CHECK_IDS.length);
    assert.deepEqual(report.results.map((result) => result.id), CHECK_IDS);
  });

  // The failure mode this guards against: preflight going green on the
  // strength of a bug in preflight.
  test('a check that throws is a failure, not a pass', async () => {
    const throwing = (blocking) => ({
      id: blocking ? 'broken-blocking' : 'broken-advisory',
      blocking,
      run: async () => {
        throw new Error('boom');
      },
    });

    const report = await run(await context(), [throwing(true), throwing(false)]);

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].summary, /the check itself failed: boom/);
    assert.equal(report.ok, false, 'a check that could not run must not leave the report green');

    // A non-blocking check that breaks is worth knowing about but does not
    // stop a push.
    assert.equal(report.results[1].status, 'warn');
  });

  test('a warning does not block, a failure does', async () => {
    const fixed = (id, status, blocking) => ({
      id,
      blocking,
      run: async () => ({ id, status, blocking, summary: id }),
    });

    assert.equal((await run(await context(), [fixed('a', 'warn', false)])).ok, true);
    assert.equal((await run(await context(), [fixed('b', 'skip', true)])).ok, true);
    assert.equal((await run(await context(), [fixed('c', 'fail', true)])).ok, false);
  });

  test('the checks deferred to later stages skip rather than pass', async () => {
    const report = await run(await context());
    const deferred = ['slice-standalone', 'e2e-stability', 'e2e-environment'];

    for (const id of deferred) {
      const result = report.results.find((entry) => entry.id === id);
      assert.equal(result.status, 'skip', `${id} must not report a pass for work it did not do`);
      assert.match(result.summary, /stage [35]/);
    }
  });

  test('format marks a red report and counts the blocking failures', () => {
    const text = format({
      ok: false,
      results: [
        { id: 'lint', status: 'pass', blocking: true, summary: 'lint:check' },
        { id: 'tests', status: 'fail', blocking: true, summary: 'failing: test:main', remedy: 'fix them' },
      ],
    });

    assert.match(text, /preflight: RED/);
    assert.match(text, /1 blocking failure\./);
    assert.match(text, /→ fix them/);
  });
});

describe('script scoping', () => {
  // None of these mappings is derivable, which is the whole reason candidates
  // are tried instead of a name being computed.
  test('candidates cover the shapes podman-desktop actually uses', () => {
    assert.ok(candidatesFor('test', { name: '@podman-desktop/core-api', path: 'packages/api' }).includes('test:core-api'));
    assert.ok(candidatesFor('test', { name: '@podman-desktop/ui-svelte', path: 'packages/ui' }).includes('test:ui'));
    assert.ok(candidatesFor('test', { name: 'podman', path: 'extensions/podman' }).includes('test:extensions:podman'));
  });

  test('scoping picks the script for the package the diff touches', async () => {
    const scope = await scopedScripts(await context(), { verb: 'test', fallback: ['test:unit'] });

    assert.deepEqual(scope.packages, ['@podman-desktop/main']);
    assert.deepEqual(scope.scripts, ['test:main']);
    assert.equal(scope.usedFallback, false);
  });

  // The fallback is not silent. A package that quietly stopped being covered
  // has to be visible in the report rather than absorbed by a green tick.
  test('a package with no script of its own names itself in unresolved', async () => {
    const scope = await scopedScripts(await context(), { verb: 'typecheck', fallback: ['typecheck'] });

    assert.deepEqual(scope.unresolved, ['@podman-desktop/main']);
    assert.equal(scope.usedFallback, true);
    assert.deepEqual(scope.scripts, ['typecheck']);
  });

  test('runScript uses the configured package manager', async () => {
    assert.equal(runScript(await context(), 'test:main'), 'npm run test:main');
  });
});

describe('the checks that run commands', () => {
  test('tests: a passing script passes, and the output is attached', async () => {
    const report = await run(await context());
    const result = report.results.find((entry) => entry.id === 'tests');

    assert.equal(result.status, 'pass');
    assert.match(result.output, /main tests ok/);
  });

  test('lint: resolves lint:check rather than lint', async () => {
    const report = await run(await context());
    const result = report.results.find((entry) => entry.id === 'lint');

    assert.equal(result.status, 'pass');
    assert.equal(result.summary, 'lint:check');
  });

  // What a failing gate has to look like: red, named, and carrying the output
  // that says why.
  test('a failing script fails the report and blocks it', async () => {
    const prepared = await context();
    const report = await run({
      ...prepared,
      changedFiles: ['packages/renderer/src/x.ts'],
      changed: [{ status: 'M', path: 'packages/renderer/src/x.ts' }],
    });
    const result = report.results.find((entry) => entry.id === 'tests');

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /test:renderer/);
    assert.match(result.output, /renderer failed/);
    assert.equal(report.ok, false);
  });

  test('schemas: skipped when the diff cannot have changed them', async () => {
    const report = await run(await context());
    const result = report.results.find((entry) => entry.id === 'schemas');

    assert.equal(result.status, 'skip');
  });

  test('a missing script is a skip that says so, never a silent pass', async () => {
    const prepared = await context();
    const report = await run({ ...prepared, scripts: {} });

    for (const id of ['tests', 'lint', 'typecheck', 'schemas']) {
      const result = report.results.find((entry) => entry.id === id);
      assert.equal(result.status, 'skip', `${id} should skip when no script exists`);
      assert.match(result.summary, /no .* script|neither/);
    }
  });
});

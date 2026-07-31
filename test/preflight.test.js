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

import { BODY_DEPENDENT, CHECK_IDS, format, loadChecks, prepare, run } from '../lib/preflight/index.js';
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

  // The second pass of the /pd:pr flow needs only these four. Re-running
  // `pnpm test` on three packages to re-read a paragraph is minutes of
  // nothing.
  test('loadChecks can be narrowed, and refuses a name it does not have', async () => {
    const narrowed = await loadChecks(BODY_DEPENDENT);

    assert.deepEqual(narrowed.map((check) => check.id).sort(), [...BODY_DEPENDENT].sort());
    await assert.rejects(() => loadChecks(['nope']), /no such check: nope/);
  });

  test('every body-dependent check really does read the body', async () => {
    const prepared = await context();

    for (const id of BODY_DEPENDENT) {
      const checks = await loadChecks([id]);
      const withoutBody = (await run({ ...prepared, prBody: null }, checks)).results[0];

      // Either it has nothing to say about this diff, or it defers. What it
      // must never do is pass on a body it has not seen.
      assert.notEqual(withoutBody.status, 'fail', `${id} should not fail merely for lack of a body`);
      if (withoutBody.status === 'pass') {
        assert.match(
          withoutBody.summary,
          /nothing|untouched|no requirements/,
          `${id} passed without a body for a reason that is not "nothing to check"`,
        );
      }
    }
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

// A check that only ever passes is indistinguishable from a check that does
// nothing, so each of these is driven to fail as well.
describe('the upstream rule checks', () => {
  /** Run one check against a context with the given overrides. */
  async function only(id, overrides) {
    const checks = (await loadChecks()).filter((check) => check.id === id);
    const report = await run({ ...(await context()), ...overrides }, checks);
    return report.results[0];
  }

  const sha = 'abcdef1234567890';
  const signed = { 'Signed-off-by': ['Test <test@example.com>'] };

  test('spdx: an added source file without the header fails', async () => {
    await writeFile(join(repo, 'packages/main/src/naked.ts'), 'export const naked = 1;\n');

    const result = await only('spdx', {
      changed: [{ status: 'A', path: 'packages/main/src/naked.ts' }],
    });

    assert.equal(result.status, 'fail');
    assert.match(result.output, /naked\.ts/);
  });

  // Only added files. A modified file that never had a header is somebody
  // else's omission, and adopting it grows the diff for no reason.
  test('spdx: a modified file without the header is not this branch problem', async () => {
    const result = await only('spdx', {
      changed: [{ status: 'M', path: 'packages/main/src/naked.ts' }],
    });

    assert.equal(result.status, 'pass');
  });

  test('spdx: an added svelte file needs no header', async () => {
    await writeFile(join(repo, 'packages/renderer/src/X.svelte'), '<div/>\n');

    const result = await only('spdx', {
      changed: [{ status: 'A', path: 'packages/renderer/src/X.svelte' }],
    });

    assert.equal(result.status, 'pass');
    assert.match(result.summary, /no added files need a header/);
  });

  test('conventional-commits: an unknown type fails, and the remedy is not rebase -i', async () => {
    const result = await only('conventional-commits', {
      commits: [{ sha, subject: 'improve(main): things', body: '', trailers: signed }],
    });

    assert.equal(result.status, 'fail');
    assert.match(result.output, /not one of the accepted types/);
    assert.match(result.remedy, /reset --soft/);
    assert.doesNotMatch(result.remedy, /rebase -i(?! *,? *which)/);
  });

  // The 0.3 correction, at the point where it would otherwise reject valid
  // work every week.
  test('conventional-commits: a missing scope passes with a note', async () => {
    const result = await only('conventional-commits', {
      commits: [{ sha, subject: 'fix: guard the empty case', body: '', trailers: signed }],
    });

    assert.equal(result.status, 'pass');
    assert.match(result.output, /scope/);
  });

  test('signed-off-by: none fails', async () => {
    const result = await only('signed-off-by', {
      commits: [{ sha, subject: 'fix(main): x', body: '', trailers: {} }],
    });

    assert.equal(result.status, 'fail');
    assert.match(result.remedy, /commit with -s/);
  });

  test('signed-off-by: two fails, and the remedy names what produced them', async () => {
    const result = await only('signed-off-by', {
      commits: [{ sha, subject: 'fix(main): x', body: '', trailers: { 'Signed-off-by': ['A <a@b>', 'A <a@b>'] } }],
    });

    assert.equal(result.status, 'fail');
    assert.match(result.remedy, /rebase -i/);
    assert.match(result.remedy, /reset --soft/);
  });

  test('extension-api: touching the declaration without a drafted body defers rather than passes', async () => {
    const result = await only('extension-api', {
      changedFiles: ['packages/extension-api/src/extension-api.d.ts'],
      prBody: null,
    });

    assert.equal(result.status, 'skip');
    assert.match(result.summary, /not drafted yet/);
  });

  test('extension-api: a body that skips disposal fails', async () => {
    const result = await only('extension-api', {
      changedFiles: ['packages/extension-api/src/extension-api.d.ts'],
      prBody: 'This is backward compatible with existing extensions.',
    });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /disposal/);
  });

  test('extension-api: a body covering both passes', async () => {
    const result = await only('extension-api', {
      changedFiles: ['packages/extension-api/src/extension-api.d.ts'],
      prBody: 'Backward compatible: the field is optional. The listener is disposed with the extension.',
    });

    assert.equal(result.status, 'pass');
  });

  test('extension-api: an untouched declaration is skipped', async () => {
    const result = await only('extension-api', { changedFiles: ['packages/main/src/x.ts'] });
    assert.equal(result.status, 'skip');
  });
});

describe('the artefact checks', () => {
  async function only(id, overrides) {
    const checks = (await loadChecks()).filter((check) => check.id === id);
    const report = await run({ ...(await context()), ...overrides }, checks);
    return report.results[0];
  }

  /** A body with the sections these checks read. */
  const body = ({ steps = '1. Build → it builds\n2. Run → it runs\n3. Restart → still fine', notes = '- Checked on macOS.', extra = '' } = {}) =>
    `### What issues does this PR fix or reference?\n\nFixes #5001\n${extra}\n\n### How to test this PR?\n\n${steps}\n\n**Notes for reviewers**\n${notes}\n\n- [ ] Tests are covering the bug fix or the new feature\n`;

  test('branch-name: a branch for another issue fails', async () => {
    const result = await only('branch-name', { issue: 9999 });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /names issue 5001.*for 9999/);
  });

  test('branch-name: a branch that is not ours fails', async () => {
    assert.equal((await only('branch-name', { branch: 'my-feature' })).status, 'fail');
    assert.equal((await only('branch-name', { branch: null })).status, 'fail');
  });

  test('branch-name: the right branch passes', async () => {
    assert.equal((await only('branch-name', {})).status, 'pass');
  });

  // The defect this check found in itself: the section ran on past its own
  // steps and counted "Notes for reviewers" and the template checkbox as
  // steps with no expected result, failing a body the plugin had produced.
  test('steps-to-check: notes and the checkbox are not steps', async () => {
    const result = await only('steps-to-check', { prBody: body() });

    assert.equal(result.status, 'pass');
    assert.equal(result.summary, '3 steps, each with an expected result');
  });

  test('steps-to-check: fewer than three fails', async () => {
    const result = await only('steps-to-check', { prBody: body({ steps: '1. Build → it builds\n2. Run → it runs' }) });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /at least 3/);
  });

  // "Test the dialog" is not a step. What a reviewer needs is what should
  // happen.
  test('steps-to-check: a step with no expected result fails', async () => {
    const result = await only('steps-to-check', {
      prBody: body({ steps: '1. Build it\n2. Test the dialog\n3. Look at it' }),
    });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /no expected result/);
  });

  test('steps-to-check: it applies on the quickfix route too', async () => {
    const result = await only('steps-to-check', {
      route: 'quickfix',
      prBody: body({ steps: '1. Build it' }),
    });

    assert.equal(result.status, 'fail');
  });

  test('r-coverage: skipped on quickfix, and the report says why', async () => {
    const result = await only('r-coverage', { route: 'quickfix', prBody: body() });

    assert.equal(result.status, 'skip');
    assert.match(result.summary, /issue number/);
  });

  test('ci-blind-spots: an untouched blind area passes', async () => {
    const result = await only('ci-blind-spots', { changedFiles: ['packages/main/src/x.ts'] });
    assert.equal(result.status, 'pass');
  });

  // CI builds on three platforms and runs unit tests on one, and its e2e
  // failures do not block a merge. A green PR is not evidence.
  test('ci-blind-spots: packaging without Notes for reviewers fails', async () => {
    const result = await only('ci-blind-spots', {
      changedFiles: ['.electron-builder.config.cjs'],
      prBody: '### How to test this PR?\n\n1. Build → it builds\n',
    });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /packaging/);
  });

  test('ci-blind-spots: with the notes, it passes', async () => {
    const result = await only('ci-blind-spots', {
      changedFiles: ['.electron-builder.config.cjs'],
      prBody: body({ notes: '- Packaged and launched on macOS 15; CI only builds the installer.' }),
    });

    assert.equal(result.status, 'pass');
  });

  test('ci-blind-spots: before the body exists it defers rather than passing', async () => {
    const result = await only('ci-blind-spots', { changedFiles: ['packages/main/src/win32-paths.ts'], prBody: null });

    assert.equal(result.status, 'skip');
    assert.match(result.summary, /not drafted yet/);
  });

  // A warning, because every one of these is sometimes correct. Blocking
  // would train people to route around the gate.
  test('debug-leftovers: warns without blocking', async () => {
    const git = (args) => execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
    await writeFile(join(repo, 'packages/main/src/messy.ts'), 'export const f = (x: any) => { console.log(x); };\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'chore: messy\n\nSigned-off-by: Test <test@example.com>']);

    const checks = (await loadChecks()).filter((check) => check.id === 'debug-leftovers');
    const report = await run(await context(), checks);

    assert.equal(report.results[0].status, 'warn');
    assert.equal(report.ok, true, 'a warning must not block');
    assert.match(report.results[0].summary, /console\.log/);
    assert.match(report.results[0].summary, /any/);
  });
});

describe('api-surface', () => {
  // The trap itself. A symbol that looks internal but is declared in
  // extension-api.d.ts is public API, with obligations nobody thought they
  // were taking on.
  test('an added export that appears in the public surface fails', async () => {
    const surface = join(repo, 'packages/extension-api/src');
    await mkdir(surface, { recursive: true });
    await writeFile(join(surface, 'extension-api.d.ts'), 'export interface RunOptions { env?: string }\n');

    const git = (args) => execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
    await writeFile(join(repo, 'packages/main/src/exec.ts'), 'export interface RunOptions { env?: string }\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'feat(main): add RunOptions\n\nSigned-off-by: Test <test@example.com>']);

    const checks = (await loadChecks()).filter((check) => check.id === 'api-surface');
    const report = await run(await context(), checks);

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].output, /RunOptions/);
    assert.match(report.results[0].remedy, /public API/);
  });

  test('an added export that is nowhere in the surface passes', async () => {
    const git = (args) => execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
    await writeFile(join(repo, 'packages/main/src/internal.ts'), 'export interface PurelyInternal { x: number }\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'feat(main): add internal\n\nSigned-off-by: Test <test@example.com>']);

    const checks = (await loadChecks()).filter((check) => check.id === 'api-surface');
    const prepared = await context();
    const report = await run({ ...prepared, changedFiles: ['packages/main/src/internal.ts'] }, checks);

    assert.equal(report.results[0].status, 'pass');
  });
});

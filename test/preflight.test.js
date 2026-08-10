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

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { cleanup, commitAll, git as gitIn, initRepo, packageMap, seedWorkspace, writeFiles, writeTask } from './helpers/repo-fixture.js';
import { capture } from '../lib/evidence.js';
import * as ids from '../lib/ids.js';
import * as validation from '../lib/validation.js';
import { BODY_DEPENDENT, CHECK_IDS, format, loadChecks, prepare, run } from '../lib/preflight/index.js';
import * as slice from '../lib/slice.js';
import * as state from '../lib/state.js';
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
      // must never do is pass on a body it has not seen — and it must never
      // fail *because* the body is absent, which is what `skip` is for.
      if (withoutBody.status === 'pass') {
        assert.match(
          withoutBody.summary,
          /nothing|untouched|no requirements|no e2e test/,
          `${id} passed without a body for a reason that is not "nothing to check"`,
        );
      }
      if (withoutBody.status === 'fail') {
        assert.doesNotMatch(
          withoutBody.summary,
          /\bbody\b/i,
          `${id} failed for lack of a body rather than deferring; that is what skip is for`,
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

  test('the e2e checks pass only because this diff carries no test, and say so', async () => {
    // They used to be stubs returning `skip`. Now they answer, and the answer
    // on a diff with no spec in it has to name that reason — a bare `pass` here
    // would be indistinguishable from a check that examined a test and liked it.
    const report = await run(await context());

    for (const id of ['e2e-stability', 'e2e-environment']) {
      const result = report.results.find((entry) => entry.id === id);
      assert.equal(result.status, 'pass', id);
      assert.match(result.summary, /no e2e test in this diff/, id);
    }
  });

  test('validation-evidence fails an unvalidated issue on the standard route', async () => {
    const report = await run(await context(), await loadChecks(['validation-evidence']));

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].summary, /nothing was validated/);
  });

  test('validation-evidence skips the quickfix route, which does not validate at all', async () => {
    const prepared = await context();
    const report = await run({ ...prepared, route: 'quickfix' }, await loadChecks(['validation-evidence']));

    assert.equal(report.results[0].status, 'skip');
    assert.match(report.results[0].summary, /quickfix/);
  });

  test('slice-standalone skips on work that was never sliced, and says that is why', async () => {
    const report = await run(await context(), await loadChecks(['slice-standalone']));

    assert.equal(report.results[0].status, 'skip');
    assert.match(report.results[0].summary, /no slice graph/);
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

// Without this one every other result is ambiguous: the file checks read the
// committed diff and the command checks run the working tree.
describe('working-tree', () => {
  async function check() {
    const checks = await loadChecks(['working-tree']);
    return (await run(await context(), checks)).results[0];
  }

  // Earlier blocks leave files behind on purpose — the spdx cases need a file
  // on disk to read. This check is the one that notices, so it starts from a
  // clean fixture rather than from whatever ran before it.
  before(async () => {
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'chore: fixture leftovers\n\nSigned-off-by: Test <test@example.com>'], { cwd: repo });
  });

  test('a clean tree passes', async () => {
    assert.equal((await check()).status, 'pass');
  });

  test('an uncommitted change blocks, and the remedy says why it matters', async () => {
    await writeFile(join(repo, 'packages/main/src/base.ts'), 'export const base = 2;\n');

    const result = await check();
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /uncommitted/);
    assert.match(result.remedy, /base\.\.\.HEAD.*working tree/s);

    await execFileAsync('git', ['checkout', '--', 'packages/main/src/base.ts'], { cwd: repo });
  });

  // An untracked scratch file changes nothing about what is pushed — unless
  // it is a spec file, in which case the test run covers code no reviewer
  // will ever see.
  test('an untracked file warns without blocking', async () => {
    await writeFile(join(repo, 'scratch.md'), 'notes\n');

    const result = await check();
    assert.equal(result.status, 'warn');
    assert.match(result.output, /scratch\.md/);

    await rm(join(repo, 'scratch.md'));
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

  // The threshold this measures had never been measured: it was a judgement
  // made at triage, on an estimate, before any code existed.
  describe('quickfix-size', () => {
    test('it says nothing on any other route', async () => {
      assert.equal((await only('quickfix-size', { route: 'standard' })).status, 'skip');
    });

    test('it reports the size and never blocks', async () => {
      const result = await only('quickfix-size', {
        route: 'quickfix',
        config: { quickfix: { max_changed_lines: 20, max_files: 3 } },
      });

      assert.equal(result.blocking, false);
      assert.equal(result.status, 'pass');
      assert.match(result.summary, /tests excluded/);
    });

    test('a test does not count against the fix it covers', async () => {
      // Issue #18248, live: one production line and 62 test lines. Counted
      // together that is 64 against a threshold of 20, so a blocking version
      // would have escalated a one-line fix into full planning for being
      // properly tested — which is how a route meant to keep small changes
      // small would start producing thinner tests.
      const root = await initRepo('pdkit-qfsize-');

      try {
        await writeFiles(root, { 'packages/main/src/thing.ts': 'export const a = 1;\n' });
        await commitAll(root, 'chore: base');
        await gitIn(['checkout', '-q', '-b', 'work'], root);
        await writeFiles(root, {
          'packages/main/src/thing.ts': 'export const a = 2;\n',
          'packages/main/src/thing.spec.ts': `${'// a long test\n'.repeat(60)}`,
        });
        await commitAll(root, 'fix: it');

        const check = (await loadChecks(['quickfix-size']))[0];
        const result = await check.run({
          route: 'quickfix',
          repoRoot: root,
          base: 'main',
          ref: 'work',
          config: { quickfix: { max_changed_lines: 20, max_files: 3 } },
        });

        assert.equal(result.status, 'pass', '62 test lines must not escalate a two-line fix');
        assert.match(result.summary, /2 line\(s\) in 1 file\(s\), plus 60 test line\(s\) in 1/);
      } finally {
        await cleanup(root);
      }
    });

    test('a fix that outgrew the route warns and names the way back', async () => {
      const result = await only('quickfix-size', {
        route: 'quickfix',
        config: { quickfix: { max_changed_lines: 0, max_files: 3 } },
      });

      assert.equal(result.status, 'warn');
      assert.equal(result.blocking, false, 'a warning here must not stop a push');
      assert.match(result.remedy, /pdkit issue escalate/);
      assert.match(result.remedy, /nothing here decides it/);
    });
  });

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
    // The message says what the check can see — a phrasing — rather than
    // claiming the step states no result. See the case below for why.
    assert.match(result.summary, /do not read as actions with a result/);
    assert.match(result.remedy, /An arrow always counts/);
  });

  // Found on the first live run, on a body written by hand: "it reads `ls -l
  // /etc`" is an expected result, and the check rejected it because `reads` was
  // not in its vocabulary. A check that matches a phrasing has to be honest
  // about matching a phrasing, and wide enough to cover how results get written.
  test('steps-to-check: a result stated without an arrow still counts', async () => {
    const result = await only('steps-to-check', {
      prBody: body({
        steps:
          '1. Open the container details page — the Command field reads `ls -l /etc`\n' +
          '2. Run `podman ps -a` — it lists `multi-arg`\n' +
          '3. Restart the app — the selection is unchanged',
      }),
    });

    assert.equal(result.status, 'pass');
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

  // Scenario 7: the diff is mechanical and the risk is one level down, in
  // transitive dependents that unit tests on one platform never load.
  test('ci-blind-spots: a moved lockfile is a blind spot', async () => {
    const result = await only('ci-blind-spots', {
      changedFiles: ['pnpm-lock.yaml', 'packages/main/package.json'],
      prBody: '### How to test this PR?\n\n1. Start it → it starts\n',
    });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /dependency changes/);
    assert.match(result.remedy, /pnpm why/);
  });

  // A package.json edited on its own installs exactly what was installed
  // before. Asking about it would price the gate at a paragraph per renamed
  // script, and a gate that is expensive to pass is one people route around.
  test('ci-blind-spots: package.json without the lockfile is not one', async () => {
    const result = await only('ci-blind-spots', {
      changedFiles: ['packages/main/package.json'],
      prBody: '### How to test this PR?\n\n1. Start it → it starts\n',
    });

    assert.equal(result.status, 'pass');
  });

  // The remedy used to ask about the platform whatever the finding was. A
  // remedy that names the wrong thing gets answered with the wrong thing.
  test('ci-blind-spots: the remedy asks about what was actually hit', async () => {
    const result = await only('ci-blind-spots', {
      changedFiles: ['pnpm-lock.yaml'],
      prBody: '### How to test this PR?\n\n1. Start it → it starts\n',
    });

    assert.doesNotMatch(result.remedy, /name the platform you checked on/);
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

// A sliced issue is where preflight stops being a single question. Which slice
// this run is about decides what it is a diff FROM, which requirements it is
// expected to cover, and whether a stored verification still applies — and
// getting any of the three wrong produces a report that is confident about the
// wrong change.
describe('a sliced issue', () => {
  const ISSUE = 7301;
  const API = 'packages/extension-api/src/api.ts';
  const EXEC = 'packages/main/src/exec.ts';

  let sliced;
  let slicedHome;
  let slicedTrees;
  let graph;

  const config = () => ({
    repo: { base_branch: 'main', package_manager: 'npm' },
    branches: { sliced: 'DESKTOP-{issue}/{index}-{slug}' },
    slicing: { layer_order: ['extension-api', 'main', 'ui', 'tests'], verify: { install: 'never' } },
    worktrees: { root: slicedTrees, copy_files: [] },
  });

  before(async () => {
    sliced = await initRepo('pdkit-preflight-sliced-');
    slicedHome = await initRepo('pdkit-preflight-sliced-home-');
    slicedTrees = join(sliced, '..', `${sliced.split('/').pop()}-trees`);

    await seedWorkspace(sliced);
    await commitAll(sliced, 'chore: seed');

    await gitIn(['checkout', '-b', `DESKTOP-${ISSUE}/work`], sliced);
    await writeFiles(sliced, {
      [API]: '// SPDX-License-Identifier: Apache-2.0\nexport interface RunOptions { env?: string }\n',
      [EXEC]: '// SPDX-License-Identifier: Apache-2.0\nimport type { RunOptions } from "@fixture/api";\nexport function exec(_o: RunOptions) {}\n',
    });
    await commitAll(sliced, 'feat: change set');

    await state.transition(ISSUE, 'triaged', { home: slicedHome });
    await state.transition(ISSUE, 'planned', { home: slicedHome });
    for (let i = 0; i < 2; i += 1) await ids.allocateRequirement(ISSUE, { home: slicedHome });
    await ids.freezeRequirements(ISSUE, { home: slicedHome });
    await writeTask({ home: slicedHome, issue: ISSUE, id: 'T1', satisfies: ['R1'], owns: [API] });
    await writeTask({ home: slicedHome, issue: ISSUE, id: 'T2', satisfies: ['R2'], owns: [EXEC] });

    const facts = await slice.facts({ issue: ISSUE, repoRoot: sliced, home: slicedHome, config: config(), packageMap: packageMap(sliced) });
    const stored = await slice.set({
      issue: ISSUE,
      proposal: {
        slices: [
          { slug: 'api', title: 'add RunOptions', files: [API], baseSlice: null },
          { slug: 'main-exec', title: 'thread it through', files: [EXEC], baseSlice: 1 },
        ],
      },
      facts,
      config: config(),
      home: slicedHome,
    });
    assert.equal(stored.ok, true, JSON.stringify(stored.problems));

    await slice.verifyAll({ issue: ISSUE, repoRoot: sliced, home: slicedHome, config: config(), packageMap: packageMap(sliced) });

    for (const [index, subject] of [[1, 'feat(extension-api): add RunOptions'], [2, 'feat(main): thread RunOptions']]) {
      for (const to of ['plan-approved', 'implemented', 'validated', 'audited', 'sliced', 'slices-approved']) {
        await state.transition(ISSUE, to, { home: slicedHome, approvedBy: 'test' });
      }
      const made = await slice.materialize({ issue: ISSUE, index, repoRoot: sliced, subject, home: slicedHome, config: config() });
      assert.equal(made.ok, true, made.error);
    }

    graph = await slice.read(ISSUE, { home: slicedHome });
  });

  after(async () => {
    await cleanup(sliced, slicedHome, slicedTrees);
  });

  const on = (overrides = {}) => prepare({ issue: ISSUE, repoRoot: sliced, home: slicedHome, ...overrides });

  test('the base of a stacked slice is its parent branch, not main', async () => {
    // Standing on slice #2's branch, which is where /pd:pr runs preflight.
    await gitIn(['checkout', `DESKTOP-${ISSUE}/2-main-exec`], sliced);
    const prepared = await on();

    assert.equal(prepared.slice, 2, 'the slice is inferred from the branch');
    assert.equal(prepared.base, `DESKTOP-${ISSUE}/1-api`);
    // The whole point: from main this list would also contain slice #1's file.
    assert.deepEqual(prepared.changedFiles, [EXEC]);
  });

  test('and an independent slice still reads against main', async () => {
    await gitIn(['checkout', `DESKTOP-${ISSUE}/1-api`], sliced);
    const prepared = await on();

    assert.equal(prepared.slice, 1);
    assert.equal(prepared.base, 'main');
    assert.deepEqual(prepared.changedFiles, [API]);
  });

  // The base came from the graph and the ref was whatever happened to be
  // checked out, which is right only because the flow runs preflight from the
  // slice's own worktree. Found by dry-running scenario 13: a graph cut from a
  // published pull request, `--slice 1`, and a green report about a diff the
  // slice had nothing to do with.
  test('the ref is the slice branch, not whatever is checked out', async () => {
    const was = await gitIn(['branch', '--show-current'], sliced);
    await gitIn(['checkout', 'main'], sliced);

    try {
      const prepared = await on({ slice: 2 });

      assert.equal(prepared.ref, `DESKTOP-${ISSUE}/2-main-exec`);
      assert.deepEqual(prepared.changedFiles, [EXEC], 'standing on main must not empty the diff');
      assert.equal(prepared.problem, null);
    } finally {
      await gitIn(['checkout', was], sliced);
    }
  });

  // The flow materializes before it runs preflight, so no branch means the run
  // is out of order. Reporting on HEAD instead answers a question nobody asked.
  test('a slice with no branch yet is refused rather than measured', async () => {
    const branch = `DESKTOP-${ISSUE}/2-main-exec`;
    const was = await gitIn(['branch', '--show-current'], sliced);
    const sha = await gitIn(['rev-parse', branch], sliced);
    await gitIn(['checkout', 'main'], sliced);
    await gitIn(['branch', '-D', branch], sliced);

    try {
      const missing = await on({ slice: 2 });

      assert.match(missing.problem ?? '', /has no branch/);
      assert.match(missing.problem ?? '', /materialize/);
      assert.deepEqual(missing.changedFiles, [], 'nothing is measured once the run is refused');
    } finally {
      await gitIn(['branch', branch, sha], sliced);
      await gitIn(['checkout', was], sliced);
    }
  });

  // An empty diff passes every file check trivially, so the report comes out
  // green and the gate opens on a branch with nothing on it. Reached in
  // practice by a materialize whose commit the repository's pre-commit hook
  // refused: the branch was created, and empty.
  test('a slice branch with nothing on it is refused, not called green', async () => {
    const branch = `DESKTOP-${ISSUE}/2-main-exec`;
    const was = await gitIn(['branch', '--show-current'], sliced);
    const sha = await gitIn(['rev-parse', branch], sliced);
    await gitIn(['checkout', 'main'], sliced);
    await gitIn(['branch', '-f', branch, `DESKTOP-${ISSUE}/1-api`], sliced);

    try {
      const empty = await on({ slice: 2 });

      assert.match(empty.problem ?? '', /nothing lies between/);
      assert.deepEqual(empty.changedFiles, []);
    } finally {
      await gitIn(['branch', '-f', branch, sha], sliced);
      await gitIn(['checkout', was], sliced);
    }
  });

  test('slice-standalone passes on a fresh green verification', async () => {
    const report = await run(await on(), await loadChecks(['slice-standalone']));

    assert.equal(report.results[0].status, 'pass', report.results[0].summary);
    assert.match(report.results[0].summary, /slice #1 standalone on main/);
  });

  test('r-coverage asks for the slice R-IDs, not the whole frozen set', async () => {
    const prepared = await on({ prBody: 'Part of #7301\n\n| R-ID | … |\n| R1 | adds RunOptions |\n' });
    const report = await run(prepared, await loadChecks(['r-coverage']));

    // R2 belongs to slice #2 and is deliberately absent from this body.
    assert.equal(report.results[0].status, 'pass', report.results[0].summary);
    assert.match(report.results[0].summary, /R1 covered \(slice #1\)/);
  });

  test('and still fails when the slice’s own R-ID is missing', async () => {
    const prepared = await on({ prBody: 'Part of #7301, no table at all\n' });
    const report = await run(prepared, await loadChecks(['r-coverage']));

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].summary, /R1 is not mentioned/);
  });

  // "Verified" must not decay into "was verified once", and on a materialized
  // branch a mismatch also means the branch is not what was verified.
  test('slice-standalone fails once the branch moves away from what was verified', async () => {
    await writeFiles(sliced, { [API]: '// SPDX-License-Identifier: Apache-2.0\nexport interface RunOptions { env?: string; cwd?: string }\n' });
    await commitAll(sliced, 'fix(extension-api): add cwd');

    const report = await run(await on(), await loadChecks(['slice-standalone']));

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].summary, /stale/);
    assert.match(report.results[0].remedy, /slice verify/);

    await gitIn(['reset', '--hard', 'HEAD~1'], sliced);
  });

  test('and fails when the attached run has been edited', async () => {
    const path = join(slicedHome, 'issues', String(ISSUE), 'verify', 'S1.md');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace(/typecheck ok/, 'everything is fine, trust me'));

    const report = await run(await on(), await loadChecks(['slice-standalone']));

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].summary, /not a valid capture/);

    await writeFile(path, original);
  });

  test('a slice that never passed cannot be pushed on the strength of the graph', async () => {
    const path = join(slicedHome, 'issues', String(ISSUE), 'slices.json');
    const original = await readFile(path, 'utf8');
    const broken = JSON.parse(original);
    broken.slices[0].verification.ok = false;
    broken.slices[0].verification.exitCode = 1;
    await writeFile(path, JSON.stringify(broken, null, 2));

    const report = await run(await on(), await loadChecks(['slice-standalone']));

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].summary, /did not pass its standalone build/);

    await writeFile(path, original);
  });
});

// The three checks that read validation.json. Between them they carry the one
// decision of stage 5 that is not about code: `unverified` does not stop the
// pipeline, so the only thing keeping an undemonstrated step from disappearing
// is that a pull request body which does not mention it will not pass here.
describe('the validation checks', () => {
  const ISSUE = 5001;
  const SPEC = 'tests/playwright/src/specs/dialog.spec.ts';

  let vHome;

  const body = (notes) =>
    `### How to test this PR?\n\n1. Build → it builds\n\n**Notes for reviewers**\n${notes}\n\n- [ ] Tests\n`;

  /**
   * @param {string} id
   * @param {object} overrides
   */
  async function only(id, overrides = {}) {
    const checks = (await loadChecks()).filter((check) => check.id === id);
    const prepared = await prepare({ issue: ISSUE, repoRoot: repo, home: vHome });
    const report = await run({ ...prepared, ...overrides }, checks);
    return report.results[0];
  }

  before(async () => {
    vHome = await mkdtemp(join(tmpdir(), 'pdkit-preflight-validation-'));
  });

  // Each test starts from an issue that has validated nothing. Sharing a record
  // would mean a failed step recorded in one test decided the outcome of the
  // next, and the check reads the worst step by design.
  beforeEach(async () => {
    await rm(join(vHome, 'issues'), { recursive: true, force: true });
  });

  after(async () => {
    await rm(vHome, { recursive: true, force: true });
    await rm(join(repo, 'tests'), { recursive: true, force: true });
  });

  test('a step with an artefact passes without needing anything in the body', async () => {
    await validation.attach({ issue: ISSUE, home: vHome, title: 'the spec passes', run: await capture({ command: 'echo ok' }) });

    const result = await only('validation-evidence');

    assert.equal(result.status, 'pass');
    assert.match(result.summary, /every one with an artefact/);
  });

  test('a step with no artefact defers while there is no body, and fails once there is one without notes', async () => {
    await validation.attach({ issue: ISSUE, home: vHome, title: 'needs a real container engine' });

    const deferred = await only('validation-evidence');
    assert.equal(deferred.status, 'skip', 'no body yet is not a verdict');

    const failed = await only('validation-evidence', { prBody: '### How to test this PR?\n\n1. Build → it builds\n' });
    assert.equal(failed.status, 'fail');
    assert.match(failed.summary, /could not be demonstrated/);

    const named = await only('validation-evidence', {
      prBody: body('The container-engine scenario was not exercised: no engine on this machine.'),
    });
    assert.equal(named.status, 'pass');
    assert.match(named.summary, /named in Notes for reviewers/);
  });

  test('a failed step fails the check, and the remedy points at the change rather than the record', async () => {
    await validation.attach({ issue: ISSUE, home: vHome, title: 'the spec passes', run: await capture({ command: 'exit 4' }) });

    const result = await only('validation-evidence', { prBody: body('everything checked') });

    assert.equal(result.status, 'fail');
    assert.match(result.remedy, /fix the change, not the record/);
  });

  test('an artefact edited after it was attached stops counting as evidence', async () => {
    const shot = join(repo, 'evidence.png');
    await writeFile(shot, 'first');
    await validation.attach({
      issue: ISSUE,
      home: vHome,
      repoRoot: repo,
      title: 'contrast',
      evidence: shot,
      observed: '4.6:1',
    });

    assert.equal((await only('validation-evidence')).status, 'pass');

    // The kept copy under the issue, not the source: that copy is what an
    // auditor opens, and editing the original proves nothing about it.
    await writeFile(join(vHome, 'issues', String(ISSUE), 'validation', 'artefacts', 'V1.png'), 'second');
    const result = await only('validation-evidence');

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /no longer match what was attached/);

    await rm(shot);
  });

  test('e2e-stability: a spec in the diff with no series recorded fails', async () => {
    await writeFiles(repo, { [SPEC]: 'test("dialog", async () => {});\n' });

    const result = await only('e2e-stability', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /no series was recorded/);
  });

  test('e2e-stability: fewer runs than required fails, and three in a row passes', async () => {
    await writeFiles(repo, { [SPEC]: 'test("dialog", async () => {});\n' });
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'root', scripts: { ...SCRIPTS, 'test:e2e:run': 'true' } }, null, 2));

    await validation.codify({ issue: ISSUE, home: vHome, repoRoot: repo, spec: SPEC });
    await validation.stability({ issue: ISSUE, home: vHome, repoRoot: repo, runs: 2, config: { repo: { package_manager: 'npm' } } });

    const short = await only('e2e-stability', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] });
    assert.equal(short.status, 'fail');
    assert.match(short.summary, /2 of 3 consecutive/);

    await validation.stability({ issue: ISSUE, home: vHome, repoRoot: repo, runs: 3, config: { repo: { package_manager: 'npm' } } });

    const full = await only('e2e-stability', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] });
    assert.equal(full.status, 'pass');
    assert.match(full.summary, /passed \d+ times in a row/);

    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'root', scripts: SCRIPTS }, null, 2));
  });

  test('e2e-stability: a spec edited after the series fails rather than passing on a stale run', async () => {
    await writeFiles(repo, { [SPEC]: 'test("dialog", async () => {});\n' });
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'root', scripts: { ...SCRIPTS, 'test:e2e:run': 'true' } }, null, 2));

    await validation.codify({ issue: ISSUE, home: vHome, repoRoot: repo, spec: SPEC });
    await validation.stability({ issue: ISSUE, home: vHome, repoRoot: repo, runs: 3, config: { repo: { package_manager: 'npm' } } });
    assert.equal((await only('e2e-stability', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] })).status, 'pass');

    await writeFiles(repo, { [SPEC]: 'test("dialog", async () => { /* edited */ });\n' });
    const result = await only('e2e-stability', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /changed after the runs were recorded/);

    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'root', scripts: SCRIPTS }, null, 2));
  });

  test('e2e-environment: a test that needs a container engine must say so in the body', async () => {
    await writeFiles(repo, {
      [SPEC]: 'test.skip(process.env.TEST_PODMAN_MACHINE !== "true", "needs a machine");\n',
    });

    const deferred = await only('e2e-environment', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] });
    assert.equal(deferred.status, 'skip');

    const failed = await only('e2e-environment', {
      changed: [{ status: 'A', path: SPEC }],
      changedFiles: [SPEC],
      prBody: '### How to test this PR?\n\n1. Build → it builds\n',
    });
    assert.equal(failed.status, 'fail');
    assert.match(failed.summary, /container engine/);

    const named = await only('e2e-environment', {
      changed: [{ status: 'A', path: SPEC }],
      changedFiles: [SPEC],
      prBody: body('This spec skips without TEST_PODMAN_MACHINE, so CI will not exercise it.'),
    });
    assert.equal(named.status, 'pass');
  });

  test('e2e-environment: a test that needs nothing special passes', async () => {
    await writeFiles(repo, { [SPEC]: 'test("dialog", async () => { await page.click("#ok"); });\n' });

    const result = await only('e2e-environment', { changed: [{ status: 'A', path: SPEC }], changedFiles: [SPEC] });

    assert.equal(result.status, 'pass');
    assert.match(result.summary, /none needing anything special/);
  });
});

// SPDX-License-Identifier: Apache-2.0

// A real git repository to test against.
//
// Not a mock. Everything the slicer and the worktree module do is git behaviour
// — applying a partial diff, detaching a tree, cleaning without touching
// node_modules — and a fake git would only ever confirm what the fake believes.
// The repositories built here are tiny, so the cost is a few hundred
// milliseconds per suite.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const exec = promisify(execFile);

/**
 * Run git in a directory and fail loudly. A fixture that half-built itself
 * produces test failures that read as bugs in the code under test.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

/**
 * Write files given as a path -> content map, creating directories.
 *
 * @param {string} root
 * @param {Record<string, string>} files
 * @returns {Promise<void>}
 */
export async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/**
 * Stage everything and commit.
 *
 * @param {string} root
 * @param {string} message
 * @returns {Promise<string>} the commit sha
 */
export async function commitAll(root, message) {
  await git(['add', '-A'], root);
  await git(['commit', '-m', message], root);
  return git(['rev-parse', 'HEAD'], root);
}

/**
 * An empty repository on `main`, with identity configured so commits work on a
 * machine that has no global git config.
 *
 * The path goes through realpath: on macOS the temp directory is a symlink, git
 * reports the resolved form, and a test comparing the two would fail for a
 * reason that has nothing to do with what it is testing. That exact mismatch
 * shipped a hole in the ownership hook in stage 2.
 *
 * @param {string} [prefix]
 * @returns {Promise<string>} absolute path
 */
export async function initRepo(prefix = 'pdkit-fixture-') {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));

  await git(['init', '-b', 'main'], root);
  await git(['config', 'user.email', 'fixture@example.test'], root);
  await git(['config', 'user.name', 'Fixture'], root);
  await git(['config', 'commit.gpgsign', 'false'], root);

  return root;
}

/**
 * Remove a fixture, including any worktrees created beside it.
 *
 * @param {...string} paths
 * @returns {Promise<void>}
 */
export async function cleanup(...paths) {
  for (const path of paths) {
    if (path) await rm(path, { recursive: true, force: true });
  }
}

/**
 * A workspace shaped like the fork, cut down to four packages across four
 * layers, plus scripts preflight and slice verification can actually run.
 *
 * `typecheck` is the interesting one: it fails when packages/main references a
 * symbol that packages/extension-api does not declare. That is symbol
 * dependence — the thing file lists cannot see and standalone verification
 * exists to find — reproduced in a way that costs no compiler.
 *
 * @param {string} root
 * @returns {Promise<void>}
 */
export async function seedWorkspace(root) {
  await writeFiles(root, {
    'pnpm-workspace.yaml': ["packages:", "  - 'packages/*'", "  - 'tests/*'", ''].join('\n'),
    'pnpm-lock.yaml': 'lockfileVersion: 1\n',
    'package.json': `${JSON.stringify(
      {
        name: 'fixture-workspace',
        private: true,
        scripts: {
          typecheck: 'node scripts/typecheck.mjs',
          'lint:check': 'node -e "process.exit(0)"',
          'test:main': 'node -e "process.exit(0)"',
          'test:ui': 'node -e "process.exit(0)"',
          'test:unit': 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
    'scripts/typecheck.mjs': [
      "import { readFile } from 'node:fs/promises';",
      '',
      'const read = async (path) => {',
      '  try { return await readFile(path, "utf8"); } catch { return ""; }',
      '};',
      '',
      'const main = await read("packages/main/src/exec.ts");',
      'const api = await read("packages/extension-api/src/api.ts");',
      '',
      'if (main.includes("RunOptions") && !api.includes("interface RunOptions")) {',
      '  console.error("packages/main/src/exec.ts: cannot find name RunOptions");',
      '  process.exit(2);',
      '}',
      'console.log("typecheck ok");',
      '',
    ].join('\n'),
    'packages/extension-api/package.json': `${JSON.stringify({ name: '@fixture/api' })}\n`,
    'packages/extension-api/src/api.ts': '// SPDX-License-Identifier: Apache-2.0\nexport const version = 1;\n',
    'packages/main/package.json': `${JSON.stringify({ name: '@fixture/main' })}\n`,
    'packages/main/src/exec.ts': '// SPDX-License-Identifier: Apache-2.0\nexport function exec() {}\n',
    'packages/ui/package.json': `${JSON.stringify({ name: '@fixture/ui' })}\n`,
    'packages/ui/src/theme.ts': '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "light";\n',
    'tests/playwright/package.json': `${JSON.stringify({ name: '@fixture/tests' })}\n`,
    'tests/playwright/smoke.spec.ts': '// SPDX-License-Identifier: Apache-2.0\n',
  });
}

/**
 * A task file under an issue, in the shape templates/task.md renders.
 *
 * Slicing reads these to answer which R-IDs a file carries, so a test about
 * requirement coverage needs real ones rather than a hand-written graph.
 *
 * @param {{home: string, issue: number, id: string, satisfies: string[], owns: string[]}} input
 * @returns {Promise<void>}
 */
export async function writeTask(input) {
  const directory = join(input.home, 'issues', String(input.issue), 'tasks');
  await mkdir(directory, { recursive: true });

  await writeFile(
    join(directory, `${input.id}.md`),
    [
      `# ${input.id}: work`,
      '',
      `- Issue: ${input.issue}`,
      `- Satisfies: ${input.satisfies.join(', ')}`,
      '- Status: done',
      '',
      '## Owns',
      ...input.owns.map((path) => `- ${path}`),
      '',
      '## Done when',
      '```bash',
      'true',
      '```',
      'Expected: nothing',
      '',
    ].join('\n'),
  );
}

/**
 * The package map the modules under test read, without going through
 * `pdkit init`.
 *
 * @returns {{generatedAt: string, workspaceRoot: string, layers: string[], packages: Record<string, {path: string, layer: string}>}}
 */
export function packageMap(root = '/fixture') {
  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot: root,
    layers: ['extension-api', 'main', 'ui', 'tests', 'other'],
    packages: {
      '@fixture/api': { path: 'packages/extension-api', layer: 'extension-api' },
      '@fixture/main': { path: 'packages/main', layer: 'main' },
      '@fixture/ui': { path: 'packages/ui', layer: 'ui' },
      '@fixture/tests': { path: 'tests/playwright', layer: 'tests' },
    },
  };
}

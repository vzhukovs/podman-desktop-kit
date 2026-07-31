// SPDX-License-Identifier: Apache-2.0

// Structural invariants from section 2.2 of the specification.
//
// These are not behaviour tests. They are the guards on two properties that
// nothing else can check, because both are about what the code is *allowed to
// contain* rather than what it does when run. A second writer of state.json or
// a second copy of the hook table would not fail any behaviour test — it would
// pass every one of them, right up until the two copies disagreed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Drop comments, so an invariant stated in prose is not mistaken for a
 * violation of itself. Several modules explain why they must not touch
 * state.json, and saying so is the opposite of the problem.
 *
 * @param {string} source
 * @returns {string}
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * Every .js file under lib/, with its path relative to lib/.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<Array<{name: string, source: string, code: string}>>}
 */
async function modules(dir = LIB, prefix = '') {
  const found = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await modules(join(dir, entry.name), relative)));
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;

    const source = await readFile(join(dir, entry.name), 'utf8');
    found.push({ name: relative, source, code: code(source) });
  }

  return found;
}

describe('section 2.2, invariant 1: lib/state.js is the only writer of state.json', () => {
  test('no other module names the file in code', async () => {
    const offenders = (await modules())
      .filter((module) => module.name !== 'state.js')
      .filter((module) => module.code.includes('state.json'))
      .map((module) => module.name);

    assert.deepEqual(
      offenders,
      [],
      `these modules name state.json: ${offenders.join(', ')}. The transition table is what makes ` +
        '"the gate only opens from preflight-green" a property of the system rather than a promise; ' +
        'a second writer makes it a promise again.',
    );
  });

  test('and it does not export a general-purpose mutator', async () => {
    const state = await import('../lib/state.js');
    for (const name of ['save', 'write', 'update', 'set', 'patch']) {
      assert.equal(typeof state[name], 'undefined', `lib/state.js exports "${name}"`);
    }
  });
});

describe('section 2.2, invariant 3: a verification is produced, never supplied', () => {
  test('only lib/slice.js names slices.json in code', async () => {
    const offenders = (await modules())
      .filter((module) => module.name !== 'slice.js')
      .filter((module) => module.code.includes('slices.json'))
      .map((module) => module.name);

    assert.deepEqual(
      offenders,
      [],
      `these modules name slices.json: ${offenders.join(', ')}. The Standalone column is rendered from that ` +
        'file, so a second writer is a way to type a green tick for a build that never ran.',
    );
  });

  test('and it exports no way to write one in', async () => {
    const slice = await import('../lib/slice.js');

    for (const name of ['save', 'write', 'store', 'setVerification', 'update']) {
      assert.equal(typeof slice[name], 'undefined', `lib/slice.js exports "${name}"`);
    }
  });
});

describe('section 2.2, invariant 2: the journal is append-only', () => {
  test('lib/journal.js opens files only for appending', async () => {
    const source = (await modules()).find((module) => module.name === 'journal.js').code;

    assert.equal(source.includes('writeFile'), false, 'journal.js uses writeFile, which truncates');
    assert.equal(source.includes('unlink'), false, 'journal.js deletes files');
    assert.match(source, /appendFile/);
  });
});

describe('the hook table has one owner', () => {
  test('only lib/hooks/events.js declares the event map', async () => {
    const offenders = (await modules())
      .filter((module) => module.name !== 'hooks/events.js')
      .filter((module) => /HOOK_HANDLERS\s*=/.test(module.code))
      .map((module) => module.name);

    assert.deepEqual(offenders, [], `these modules redeclare HOOK_HANDLERS: ${offenders.join(', ')}`);
  });

  test('every registered event resolves to a module that exists', async () => {
    const { HOOK_HANDLERS } = await import('../lib/hooks/events.js');
    const present = new Set((await modules()).map((module) => module.name));

    for (const [event, handler] of Object.entries(HOOK_HANDLERS)) {
      assert.ok(present.has(`hooks/${handler}`), `${event} -> lib/hooks/${handler} does not exist`);
    }
  });

  // The gate must not be switchable off by a module that fails to load. Every
  // other event may fail open; this one may not, and the difference is one
  // entry in a list that is easy to edit without noticing what it decides.
  test('pre-bash fails closed', async () => {
    const { FAIL_CLOSED, HOOK_HANDLERS } = await import('../lib/hooks/events.js');

    assert.ok(FAIL_CLOSED.includes('pre-bash'), 'pre-bash guards upstream writes and must fail closed');
    for (const event of FAIL_CLOSED) {
      assert.ok(event in HOOK_HANDLERS, `FAIL_CLOSED names "${event}", which is not a registered event`);
    }
  });
});

// A skill is instructions the model follows. One naming a command that does
// not exist fails mid-flow, with the model improvising a substitute — which is
// exactly the moment improvisation is least wanted.
describe('skills only name commands that exist', () => {
  /**
   * Code spans and fenced blocks only.
   *
   * Prose mentions pdkit too — "check the pdkit environment" is a sentence,
   * not an invocation — and matching it would make this test fail on English
   * rather than on a wrong command.
   *
   * @param {string} markdown
   * @returns {string}
   */
  function codeOnly(markdown) {
    const fenced = [...markdown.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
    const inline = [...markdown.matchAll(/`[^`\n]+`/g)].map((match) => match[0]);
    return [...fenced, ...inline].join('\n');
  }

  test('every `pdkit <command>` in a written skill is a real command', async () => {
    const { COMMANDS } = await import('../lib/cli.js');
    const skillsDir = join(ROOT, 'skills');

    const problems = [];
    for (const entry of await readdir(skillsDir)) {
      const text = await readFile(join(skillsDir, entry, 'SKILL.md'), 'utf8');

      // A stub is not instructions anybody follows, and it may name a command
      // from the stage it is waiting for.
      if (text.includes('> Stub.')) continue;

      for (const [, command] of codeOnly(text).matchAll(/\bpdkit ([a-z][a-z-]*)/g)) {
        if (!COMMANDS.includes(command)) problems.push(`${entry}: pdkit ${command}`);
      }
    }

    assert.deepEqual(problems, [], `these skills name commands pdkit does not have:\n  ${problems.join('\n  ')}`);
  });

  test('the dispatcher and the exported list agree', async () => {
    const { COMMANDS } = await import('../lib/cli.js');
    const source = await readFile(join(ROOT, 'lib', 'cli.js'), 'utf8');

    for (const command of COMMANDS) {
      // `version` is answered before the switch, since --version has to work
      // without a command at all.
      const handled =
        new RegExp(`case '${command}':`).test(source) || new RegExp(`command === '${command}'`).test(source);
      assert.ok(handled, `COMMANDS lists "${command}" but nothing in the dispatcher handles it`);
    }
  });

  test('every dispatched command is in the exported list', async () => {
    const { COMMANDS } = await import('../lib/cli.js');
    const source = await readFile(join(ROOT, 'lib', 'cli.js'), 'utf8');

    // Scoped to the top-level switch: the sub-command switches inside runGate
    // and runIssue use the same syntax and are not pdkit commands.
    const body = source.slice(source.indexOf('switch (command) {'));
    for (const [, command] of body.matchAll(/^\s{6}case '([a-z-]+)':/gm)) {
      assert.ok(COMMANDS.includes(command), `the dispatcher handles "${command}", which COMMANDS does not list`);
    }
  });
});

describe('licensing', () => {
  // The plugin enforces SPDX headers upstream; failing to carry them itself
  // would be the kind of detail that costs credibility in review.
  test('every module carries an SPDX header', async () => {
    const missing = (await modules())
      .filter((module) => !module.source.startsWith('// SPDX-License-Identifier: Apache-2.0'))
      .map((module) => module.name);

    assert.deepEqual(missing, []);
  });
});

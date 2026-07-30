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

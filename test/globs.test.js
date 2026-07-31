// SPDX-License-Identifier: Apache-2.0

// Tests for lib/globs.js.
//
// This module decides whether a write is inside a task's declared ownership,
// so both directions are the point: a pattern that matches too little stops
// planned work, and one that matches too much makes the Owns map decorative.
// Every case here is written as a pair for that reason.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matches, matchesAny, matching, toRegExp } from '../lib/globs.js';

describe('literal patterns', () => {
  test('match exactly', () => {
    assert.equal(matches('packages/main/src/x.ts', 'packages/main/src/x.ts'), true);
    assert.equal(matches('packages/main/src/y.ts', 'packages/main/src/x.ts'), false);
  });

  // A file named in the plan is that file, not the directory it sits in. A
  // task owning `lib/state.js` must not thereby own `lib/state.js.bak`.
  test('do not match by prefix', () => {
    assert.equal(matches('lib/state.js.bak', 'lib/state.js'), false);
    assert.equal(matches('lib/state.jsx', 'lib/state.js'), false);
  });

  test('are not directory patterns by accident', () => {
    assert.equal(matches('packages/main/src/x.ts', 'packages/main'), false);
    assert.equal(matches('packages/main', 'packages/main'), true);
  });
});

describe('* stays inside one segment', () => {
  test('matches within the segment', () => {
    assert.equal(matches('lib/state.js', 'lib/*.js'), true);
    assert.equal(matches('lib/hooks.js', 'lib/*.js'), true);
  });

  test('and does not cross a separator', () => {
    assert.equal(matches('lib/hooks/owns.js', 'lib/*.js'), false);
    assert.equal(matches('lib/hooks/owns.js', 'lib/*/*.js'), true);
  });

  test('? is one character, and not a separator', () => {
    assert.equal(matches('lib/T1.md', 'lib/T?.md'), true);
    assert.equal(matches('lib/T12.md', 'lib/T?.md'), false);
    assert.equal(matches('lib/a/b.md', 'lib/a?b.md'), false);
  });
});

describe('** spans segments', () => {
  test('a trailing ** covers everything below', () => {
    assert.equal(matches('packages/main/src/x.ts', 'packages/main/**'), true);
    assert.equal(matches('packages/main/x.ts', 'packages/main/**'), true);
    assert.equal(matches('packages/renderer/src/x.ts', 'packages/main/**'), false);
  });

  // The directory itself is not a file, and reading `a/**` as covering `a`
  // would make an ownership entry cover something nothing writes to.
  test('a trailing ** does not cover the directory itself', () => {
    assert.equal(matches('packages/main', 'packages/main/**'), false);
  });

  test('a middle ** matches zero segments as well as many', () => {
    assert.equal(matches('src/x.ts', 'src/**/x.ts'), true);
    assert.equal(matches('src/a/x.ts', 'src/**/x.ts'), true);
    assert.equal(matches('src/a/b/x.ts', 'src/**/x.ts'), true);
    assert.equal(matches('src/a/b/y.ts', 'src/**/x.ts'), false);
  });

  test('a leading ** matches at any depth', () => {
    assert.equal(matches('x.ts', '**/x.ts'), true);
    assert.equal(matches('a/b/x.ts', '**/x.ts'), true);
  });
});

describe('refusals', () => {
  // Refused rather than approximated: `src/**.ts` read as `src/*.ts` differs
  // exactly where it matters — how deep the permission reaches — and the plan
  // that meant one and got the other would not show it until a worker wrote
  // outside its files.
  test('** that is not a whole segment is an error, not a guess', () => {
    assert.throws(() => toRegExp('src/**.ts'), /whole path segment/);
    assert.throws(() => toRegExp('src/a**/x.ts'), /whole path segment/);
  });

  test('an empty pattern is an error', () => {
    assert.throws(() => toRegExp(''), /empty pattern/);
  });
});

describe('normalization', () => {
  test('a leading ./ and duplicate slashes do not change the answer', () => {
    assert.equal(matches('./lib/state.js', 'lib/state.js'), true);
    assert.equal(matches('lib//state.js', 'lib/state.js'), true);
    assert.equal(matches('lib/state.js', './lib/state.js'), true);
  });

  test('a trailing slash means the directory and everything under it', () => {
    assert.equal(matches('lib/hooks/owns.js', 'lib/hooks/'), true);
    assert.equal(matches('lib/hooks/nested/deep.js', 'lib/hooks/'), true);
    assert.equal(matches('lib/hooksx/owns.js', 'lib/hooks/'), false);
  });

  test('a Windows-style path is compared as a POSIX one', () => {
    assert.equal(matches('lib\\hooks\\owns.js', 'lib/hooks/*.js'), true);
  });
});

describe('lists', () => {
  test('matchesAny is true when any pattern claims the path', () => {
    const owns = ['packages/main/src/plugin/container-registry.ts', 'packages/main/src/**/*.spec.ts'];

    assert.equal(matchesAny('packages/main/src/plugin/container-registry.ts', owns), true);
    assert.equal(matchesAny('packages/main/src/plugin/container-registry.spec.ts', owns), true);
    assert.equal(matchesAny('packages/renderer/src/App.svelte', owns), false);
  });

  // A task that owns nothing owns nothing. Reading an empty list as "no
  // constraint" would turn a planning mistake into unrestricted write access.
  test('an empty list matches nothing', () => {
    assert.equal(matchesAny('anything.ts', []), false);
    assert.equal(matchesAny('anything.ts', undefined), false);
  });

  test('matching reports which entries claimed the path', () => {
    assert.deepEqual(matching('lib/state.js', ['lib/*.js', 'lib/state.js', 'test/**']), ['lib/*.js', 'lib/state.js']);
  });
});

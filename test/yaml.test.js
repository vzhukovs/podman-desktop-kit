// SPDX-License-Identifier: Apache-2.0

// Contract for lib/yaml.js — specifically, where the supported subset ends.
//
// The tests that matter most here are the ones asserting a *throw*. A partial
// YAML reader that silently drops a construct it does not understand produces a
// config that looks loaded and is missing a key, and the loss surfaces later as
// a wrong decision somewhere unrelated. Failing to parse is recoverable;
// parsing wrongly is not.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse, stringify, YamlError } from '../lib/yaml.js';

describe('supported subset', () => {
  test('scalars', { todo: true }, () => {
    assert.deepEqual(parse('a: hello\nb: 12\nc: true\nd: false\ne: null'), {
      a: 'hello',
      b: 12,
      c: true,
      d: false,
      e: null,
    });
  });

  test('quoted strings keep characters that would otherwise be syntax', { todo: true }, () => {
    assert.deepEqual(parse('a: "x: y"\nb: \'# not a comment\''), {
      a: 'x: y',
      b: '# not a comment',
    });
  });

  test('nested maps', { todo: true }, () => {
    assert.deepEqual(parse('slicing:\n  strategy: prefer-independent\n  max_files_per_slice: 12'), {
      slicing: { strategy: 'prefer-independent', max_files_per_slice: 12 },
    });
  });

  test('block sequences', { todo: true }, () => {
    assert.deepEqual(parse('layers:\n  - main\n  - renderer'), {
      layers: ['main', 'renderer'],
    });
  });

  test('inline sequences', { todo: true }, () => {
    assert.deepEqual(parse('layers: [main, renderer]'), { layers: ['main', 'renderer'] });
  });

  test('comments and blank lines are ignored', { todo: true }, () => {
    assert.deepEqual(parse('# header\n\na: 1  # trailing\n'), { a: 1 });
  });

  test('parses the shipped default config', { todo: true }, async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../defaults/config.yaml', import.meta.url), 'utf8');
    const config = parse(source);
    assert.equal(config.version, 1);
    assert.equal(config.slicing.strategy, 'prefer-independent');
    // The absence of routing: is a design decision (spec section 5), not an
    // omission. If it ever reappears here, something reintroduced a second
    // source of truth for model selection.
    assert.equal(config.routing, undefined);
  });
});

describe('outside the subset — must throw, never degrade', () => {
  test('anchors', { todo: true }, () => {
    assert.throws(() => parse('a: &anchor 1\nb: *anchor'), YamlError);
  });

  test('block scalars', { todo: true }, () => {
    assert.throws(() => parse('a: |\n  line one\n  line two'), YamlError);
    assert.throws(() => parse('a: >\n  folded'), YamlError);
  });

  test('multiple documents', { todo: true }, () => {
    assert.throws(() => parse('a: 1\n---\nb: 2'), YamlError);
  });

  test('tags', { todo: true }, () => {
    assert.throws(() => parse('a: !!str 1'), YamlError);
  });

  test('the error names the line', { todo: true }, () => {
    try {
      parse('a: 1\nb: |\n  x');
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof YamlError);
      assert.equal(error.line, 2);
    }
  });
});

describe('stringify', () => {
  test('round-trips through parse', { todo: true }, () => {
    const value = { slicing: { strategy: 'stack', layers: ['main', 'ui'] } };
    assert.deepEqual(parse(stringify(value)), value);
  });
});

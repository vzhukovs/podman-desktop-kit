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
  test('scalars',() => {
    assert.deepEqual(parse('a: hello\nb: 12\nc: true\nd: false\ne: null'), {
      a: 'hello',
      b: 12,
      c: true,
      d: false,
      e: null,
    });
  });

  test('quoted strings keep characters that would otherwise be syntax',() => {
    assert.deepEqual(parse('a: "x: y"\nb: \'# not a comment\''), {
      a: 'x: y',
      b: '# not a comment',
    });
  });

  test('nested maps',() => {
    assert.deepEqual(parse('slicing:\n  strategy: prefer-independent\n  max_files_per_slice: 12'), {
      slicing: { strategy: 'prefer-independent', max_files_per_slice: 12 },
    });
  });

  test('block sequences',() => {
    assert.deepEqual(parse('layers:\n  - main\n  - renderer'), {
      layers: ['main', 'renderer'],
    });
  });

  test('inline sequences',() => {
    assert.deepEqual(parse('layers: [main, renderer]'), { layers: ['main', 'renderer'] });
  });

  test('comments and blank lines are ignored',() => {
    assert.deepEqual(parse('# header\n\na: 1  # trailing\n'), { a: 1 });
  });

  test('parses the shipped default config',async () => {
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

  // The second real input the subset has to cover. Copied from the fork rather
  // than read from disk: the test has to pass on a machine that has no clone.
  test("parses podman-desktop's pnpm-workspace.yaml", () => {
    const source = [
      'engineStrict: true',
      'packages:',
      "  - 'packages/*'",
      "  - 'extensions/*/packages/*'",
      "  - 'tests/*'",
      'onlyBuiltDependencies:',
      "  - '@biomejs/biome'",
      '  - core-js',
      '  - electron',
    ].join('\n');

    assert.deepEqual(parse(source), {
      engineStrict: true,
      packages: ['packages/*', 'extensions/*/packages/*', 'tests/*'],
      onlyBuiltDependencies: ['@biomejs/biome', 'core-js', 'electron'],
    });
  });

  // Written under its key rather than beside it. The shipped config uses this
  // shape for quickfix.forbid_paths, so it is not a hypothetical.
  test('an inline sequence indented under its key', () => {
    assert.deepEqual(parse('tools:\n  never_rewrite:\n    [git push, gh pr]\n  enabled: auto'), {
      tools: { never_rewrite: ['git push', 'gh pr'], enabled: 'auto' },
    });
  });

  // YAML 1.1 would make these booleans. The config uses them as enum members
  // beside `auto`, and a field that is sometimes a string and sometimes a
  // boolean is a bug waiting for the first consumer that trusts one of them.
  test('on and off stay strings', () => {
    assert.deepEqual(parse('a: on\nb: off\nc: auto'), { a: 'on', b: 'off', c: 'auto' });
  });
});

describe('outside the subset — must throw, never degrade', () => {
  test('anchors',() => {
    assert.throws(() => parse('a: &anchor 1\nb: *anchor'), YamlError);
  });

  test('block scalars',() => {
    assert.throws(() => parse('a: |\n  line one\n  line two'), YamlError);
    assert.throws(() => parse('a: >\n  folded'), YamlError);
  });

  test('multiple documents',() => {
    assert.throws(() => parse('a: 1\n---\nb: 2'), YamlError);
  });

  test('tags',() => {
    assert.throws(() => parse('a: !!str 1'), YamlError);
  });

  test('the error names the line',() => {
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
  test('round-trips through parse',() => {
    const value = { slicing: { strategy: 'stack', layers: ['main', 'ui'] } };
    assert.deepEqual(parse(stringify(value)), value);
  });
});

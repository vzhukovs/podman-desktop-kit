// SPDX-License-Identifier: Apache-2.0

// Contract for lib/hooks/command-parse.js.
//
// Written before the implementation, because this parser is what stands between
// an agent and an unreviewed push to someone else's repository. Every case here
// is a way the naive approach — substring matching on the raw command — gets it
// wrong.
//
// The cases are marked todo until stage 1 implements the parser. They are not
// placeholders: each one is a decision the implementation has to make, and
// removing the todo marker is what "stage 1 is done" means.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse, matches, hasFlag } from '../lib/hooks/command-parse.js';

describe('parse', () => {
  test('splits on && so a chained push is still seen', { todo: true }, () => {
    const commands = parse('npm test && git push origin main');
    assert.equal(commands.length, 2);
    assert.equal(commands[1].program, 'git');
    assert.deepEqual(commands[1].args, ['push', 'origin', 'main']);
  });

  test('splits on || and ; too', { todo: true }, () => {
    assert.equal(parse('a || b').length, 2);
    assert.equal(parse('a; b').length, 2);
    assert.equal(parse('a\nb').length, 2);
  });

  test('strips leading variable assignments', { todo: true }, () => {
    const [command] = parse('FOO=bar BAZ=qux git push');
    assert.equal(command.program, 'git');
    assert.deepEqual(command.args, ['push']);
  });

  test('descends into $() substitutions', { todo: true }, () => {
    const commands = parse('echo $(git push)');
    assert.ok(commands.some((c) => c.program === 'git' && c.args[0] === 'push'));
  });

  test('descends into backtick substitutions', { todo: true }, () => {
    const commands = parse('echo `git push`');
    assert.ok(commands.some((c) => c.program === 'git' && c.args[0] === 'push'));
  });

  // The rtk case from spec section 8.2. A rewriter that turns `git push` into
  // `rtk git push` must not become a way past the gate.
  test('unwraps wrapper programs and records what was stripped', { todo: true }, () => {
    const [command] = parse('rtk git push origin main');
    assert.equal(command.program, 'git');
    assert.deepEqual(command.args, ['push', 'origin', 'main']);
    assert.deepEqual(command.wrappers, ['rtk']);
  });

  test('unwraps nested wrappers', { todo: true }, () => {
    const [command] = parse('env FOO=1 nice rtk git push');
    assert.equal(command.program, 'git');
  });

  test('unquotes a quoted program name', { todo: true }, () => {
    assert.equal(parse("'git' push")[0].program, 'git');
    assert.equal(parse('"git" push')[0].program, 'git');
  });

  test('collapses repeated whitespace', { todo: true }, () => {
    const [command] = parse('git   push    origin');
    assert.deepEqual(command.args, ['push', 'origin']);
  });

  test('keeps the raw segment for error messages', { todo: true }, () => {
    assert.equal(parse('git push')[0].raw, 'git push');
  });

  test('returns an empty list for an empty command', { todo: true }, () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse('   '), []);
  });

  // A quoted argument that merely mentions a command is not that command.
  // Getting this wrong in the other direction blocks legitimate work, and a
  // gate that blocks legitimate work is a gate people route around.
  test('does not treat a quoted string as a command', { todo: true }, () => {
    const commands = parse('git commit -m "do not git push yet"');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].args[0], 'commit');
  });
});

describe('matches', () => {
  test('matches on program and argument prefix', { todo: true }, () => {
    assert.equal(matches('git push origin main', 'git', ['push']), true);
    assert.equal(matches('git status', 'git', ['push']), false);
  });

  test('matches a wrapped command', { todo: true }, () => {
    assert.equal(matches('rtk git push', 'git', ['push']), true);
  });

  test('matches a multi-token prefix', { todo: true }, () => {
    assert.equal(matches('gh issue comment 5 --body x', 'gh', ['issue', 'comment']), true);
    assert.equal(matches('gh issue list', 'gh', ['issue', 'comment']), false);
  });
});

describe('hasFlag', () => {
  test('finds a bare flag', { todo: true }, () => {
    const [command] = parse('git push --force');
    assert.equal(hasFlag(command, '--force'), true);
  });

  test('finds a flag written with =', { todo: true }, () => {
    const [command] = parse('git push --force-with-lease=main');
    assert.equal(hasFlag(command, '--force-with-lease'), true);
  });

  // --force-with-lease starts with --force. Prefix matching here would read a
  // safe push as a forced one, and the difference is the whole rule.
  test('does not confuse --force with --force-with-lease', { todo: true }, () => {
    const [command] = parse('git push --force-with-lease');
    assert.equal(hasFlag(command, '--force'), false);
  });
});

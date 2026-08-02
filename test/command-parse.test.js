// SPDX-License-Identifier: Apache-2.0

// Contract for lib/hooks/command-parse.js.
//
// Written before the implementation, because this parser is what stands between
// an agent and an unreviewed push to someone else's repository. Every case here
// is a way the naive approach — substring matching on the raw command — gets it
// wrong.
//
// The parse, matches and hasFlag blocks are the original contract, written at
// skeleton time and implemented in stage 1. The last block is not: those cases
// were found while writing the parser, and each one is a shape of `git push`
// that the contract as written would have let through. They are asserted here
// rather than trusted, because "the parser probably handles that" is the
// belief this whole file exists to replace.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse, matches, hasFlag, optionValue } from '../lib/hooks/command-parse.js';

describe('parse', () => {
  test('splits on && so a chained push is still seen', () => {
    const commands = parse('npm test && git push origin main');
    assert.equal(commands.length, 2);
    assert.equal(commands[1].program, 'git');
    assert.deepEqual(commands[1].args, ['push', 'origin', 'main']);
  });

  test('splits on || and ; too', () => {
    assert.equal(parse('a || b').length, 2);
    assert.equal(parse('a; b').length, 2);
    assert.equal(parse('a\nb').length, 2);
  });

  test('strips leading variable assignments', () => {
    const [command] = parse('FOO=bar BAZ=qux git push');
    assert.equal(command.program, 'git');
    assert.deepEqual(command.args, ['push']);
  });

  test('descends into $() substitutions', () => {
    const commands = parse('echo $(git push)');
    assert.ok(commands.some((c) => c.program === 'git' && c.args[0] === 'push'));
  });

  test('descends into backtick substitutions', () => {
    const commands = parse('echo `git push`');
    assert.ok(commands.some((c) => c.program === 'git' && c.args[0] === 'push'));
  });

  // Spec section 8.2. The plugin configures no rewriter, but one installed for
  // another project hooks the Bash tool globally, and a wrapper that turns
  // `git push` into `rtk git push` must not become a way past the gate.
  test('unwraps wrapper programs and records what was stripped', () => {
    const [command] = parse('rtk git push origin main');
    assert.equal(command.program, 'git');
    assert.deepEqual(command.args, ['push', 'origin', 'main']);
    assert.deepEqual(command.wrappers, ['rtk']);
  });

  test('unwraps nested wrappers', () => {
    const [command] = parse('env FOO=1 nice rtk git push');
    assert.equal(command.program, 'git');
  });

  test('unquotes a quoted program name', () => {
    assert.equal(parse("'git' push")[0].program, 'git');
    assert.equal(parse('"git" push')[0].program, 'git');
  });

  test('collapses repeated whitespace', () => {
    const [command] = parse('git   push    origin');
    assert.deepEqual(command.args, ['push', 'origin']);
  });

  test('keeps the raw segment for error messages', () => {
    assert.equal(parse('git push')[0].raw, 'git push');
  });

  test('returns an empty list for an empty command', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse('   '), []);
  });

  // A quoted argument that merely mentions a command is not that command.
  // Getting this wrong in the other direction blocks legitimate work, and a
  // gate that blocks legitimate work is a gate people route around.
  test('does not treat a quoted string as a command', () => {
    const commands = parse('git commit -m "do not git push yet"');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].args[0], 'commit');
  });
});

describe('matches', () => {
  test('matches on program and argument prefix', () => {
    assert.equal(matches('git push origin main', 'git', ['push']), true);
    assert.equal(matches('git status', 'git', ['push']), false);
  });

  test('matches a wrapped command', () => {
    assert.equal(matches('rtk git push', 'git', ['push']), true);
  });

  test('matches a multi-token prefix', () => {
    assert.equal(matches('gh issue comment 5 --body x', 'gh', ['issue', 'comment']), true);
    assert.equal(matches('gh issue list', 'gh', ['issue', 'comment']), false);
  });
});

describe('hasFlag', () => {
  test('finds a bare flag', () => {
    const [command] = parse('git push --force');
    assert.equal(hasFlag(command, '--force'), true);
  });

  test('finds a flag written with =', () => {
    const [command] = parse('git push --force-with-lease=main');
    assert.equal(hasFlag(command, '--force-with-lease'), true);
  });

  // --force-with-lease starts with --force. Prefix matching here would read a
  // safe push as a forced one, and the difference is the whole rule.
  test('does not confuse --force with --force-with-lease', () => {
    const [command] = parse('git push --force-with-lease');
    assert.equal(hasFlag(command, '--force'), false);
  });
});

describe('optionValue', () => {
  test('reads both spellings and stops at the first hit', () => {
    assert.equal(optionValue(parse('gh api -X POST repos/o/r')[0], ['-X', '--method']), 'POST');
    assert.equal(optionValue(parse('gh api --method=PATCH repos/o/r')[0], ['-X', '--method']), 'PATCH');
    assert.equal(optionValue(parse('gh pr create --head DESKTOP-1/x')[0], ['--head']), 'DESKTOP-1/x');
  });

  test('is null when absent, and when the option ends the line', () => {
    assert.equal(optionValue(parse('gh api repos/o/r')[0], ['-X', '--method']), null);
    assert.equal(optionValue(parse('gh api repos/o/r -X')[0], ['-X']), null);
  });
});

// Ways past the gate that the original contract did not name. Found while
// implementing it; every one of them is a working `git push` that a parser
// satisfying only the cases above would report as something else.
describe('shapes the contract did not name', () => {
  // Without parentheses as separators the program parses as "(git" and matches
  // no rule at all — a bypass that costs one character to write.
  test('sees a command inside a subshell', () => {
    assert.equal(matches('(git push origin main)', 'git', ['push']), true);
  });

  test('sees a command inside a brace group', () => {
    assert.equal(matches('{ git push; }', 'git', ['push']), true);
  });

  // argv[0] given as a path is the same program. Comparing the token as
  // written would let the full path through.
  test('matches a program named by its path', () => {
    assert.equal(parse('/usr/bin/git push')[0].program, 'git');
    assert.equal(matches('/usr/bin/git push', 'git', ['push']), true);
  });

  test('splits on a pipe and on a background operator', () => {
    assert.equal(matches('echo x | git push', 'git', ['push']), true);
    assert.equal(matches('git push & sleep 1', 'git', ['push']), true);
  });

  // Substitution runs inside double quotes as well as outside them.
  test('descends into a substitution inside double quotes', () => {
    assert.equal(matches('echo "$(git push)"', 'git', ['push']), true);
  });

  test('does not invent a command from arithmetic expansion', () => {
    const commands = parse('echo $((1 + 2))');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].program, 'echo');
  });

  // A wrapper may carry its own options before the real program. Stopping at
  // the first token after the wrapper would read the program as "-n1".
  test('looks past a wrapper own options', () => {
    assert.equal(matches('xargs -n1 git push', 'git', ['push']), true);
    assert.equal(matches('sudo -u someone rtk git push', 'git', ['push']), true);
  });

  test('survives an unterminated quote and an unterminated substitution', () => {
    assert.equal(matches("git push 'unclosed", 'git', ['push']), true);
    assert.equal(matches('echo $(git push', 'git', ['push']), true);
  });
});

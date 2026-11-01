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

// Structural invariants from section 2.2 of the specification.
//
// These are not behaviour tests. They are the guards on two properties that
// nothing else can check, because both are about what the code is *allowed to
// contain* rather than what it does when run. A second writer of state.json or
// a second copy of the hook table would not fail any behaviour test — it would
// pass every one of them, right up until the two copies disagreed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';

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

// The other half of the same failure, and the half that actually happened.
//
// On DESKTOP-18832 a session finished a plan review and told the user to run
// `/pd:implement 18832`. There is no such skill. It was not invented from
// nothing: every skill in the chain ended on a `pdkit state --to` call and named
// nothing after it, while what the machine printed was `next: implemented` — a
// STATE. Seven of the eight states in the chain are spelled like the command
// that reaches them, so the eighth gets guessed, and the guess is wrong at
// exactly the one place the two vocabularies diverge.
//
// Two properties are pinned here, because neither is visible in any behaviour
// test: that every `/pd:x` written down resolves to a skill, and that every
// state a person can be standing in says what to run from it.
describe('the handoff between skills', () => {
  /** Every skill directory that exists. */
  async function skillNames() {
    return (await readdir(join(ROOT, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  test('every /pd:<skill> named anywhere resolves to a real skill', async () => {
    const known = new Set(await skillNames());
    // Prose is included rather than only code spans, unlike the `pdkit` test
    // below, and the difference is the point: `/pd:x` is never English, so any
    // occurrence is a reference. The cost is that a document cannot quote a
    // wrong name while explaining it — which this test enforced on section 1
    // the day it was written, and the section was reworded rather than
    // exempted. CHANGELOG.md is deliberately absent: its job is to record
    // mistakes verbatim, including the names of commands that never existed.
    const files = [
      ...(await skillNames()).map((name) => join(ROOT, 'skills', name, 'SKILL.md')),
      ...(
        await Promise.all(
          ['architecture', 'configuration', 'specification', 'workflows'].map(async (dir) =>
            (await readdir(join(ROOT, 'docs', dir), { recursive: true }))
              .filter((name) => name.endsWith('.md'))
              .map((name) => join(ROOT, 'docs', dir, name)),
          ),
        )
      ).flat(),
      join(ROOT, 'README.md'),
    ];

    const problems = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const [, name] of text.matchAll(/\/pd:([a-z][a-z0-9-]*)/g)) {
        if (!known.has(name)) problems.push(`${file.slice(ROOT.length)}: /pd:${name}`);
      }
    }

    assert.deepEqual(problems, [], `these name skills that do not exist:\n  ${problems.join('\n  ')}`);
  });

  test('every plugin file an agent or skill names is reached from the plugin root', async () => {
    // Agents and skills run in the podman-desktop checkout, not in this one, so
    // a bare `knowledge/maintainer-rules.md` resolves against the wrong tree.
    // On DESKTOP-19818 the implementer looked for it there, found nothing, and
    // wrote two tasks without the maintainer's rules. Claude Code substitutes
    // ${CLAUDE_PLUGIN_ROOT} in agent and skill bodies; that prefix is the only
    // spelling that reaches the file wherever the plugin is installed. The
    // directories are the ones a session reads from: the knowledge base, the
    // templates it fills, and the skill and agent files that hand off to
    // each other. Paths inside podman-desktop (`packages/…`, `tests/…`) have
    // none of these roots, so they are not caught here.
    const agents = (await readdir(join(ROOT, 'agents'))).filter((name) => name.endsWith('.md')).map((name) => join(ROOT, 'agents', name));
    const skills = (await skillNames()).map((name) => join(ROOT, 'skills', name, 'SKILL.md'));
    const reference = /(\$\{CLAUDE_PLUGIN_ROOT\}\/)?(?<![\w./-])((?:knowledge|templates|skills|agents)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*(?:\.md)?)/g;

    const problems = [];
    for (const file of [...agents, ...skills]) {
      const text = await readFile(file, 'utf8');
      for (const [whole, prefix, path] of text.matchAll(reference)) {
        if (!prefix) {
          problems.push(`${file.slice(ROOT.length)}: ${whole} has no \${CLAUDE_PLUGIN_ROOT}/ prefix`);
          continue;
        }
        try {
          await stat(join(ROOT, path));
        } catch {
          problems.push(`${file.slice(ROOT.length)}: ${whole} does not exist`);
        }
      }
    }

    assert.deepEqual(problems, [], `these references do not resolve from a podman-desktop checkout:\n  ${problems.join('\n  ')}`);
  });

  test('every state names what to run from it, and it is a real skill', async () => {
    const { ADVANCES, TRANSITIONS, nextStep } = await import('../lib/state.js');
    const known = new Set(await skillNames());

    for (const state of Object.keys(TRANSITIONS)) {
      assert.ok(state in ADVANCES, `ADVANCES says nothing about "${state}" — a state with no next step is where a command gets guessed`);

      const skill = ADVANCES[state];
      if (skill !== null) assert.ok(known.has(skill), `ADVANCES sends "${state}" to /pd:${skill}, which is not a skill`);

      // Terminal states are the only ones allowed to answer nothing, plus the
      // two whose next move is a person's decision rather than a command.
      const terminal = (TRANSITIONS[state] ?? []).length === 0;
      const step = nextStep({ issue: 1, state, route: null });
      if (!terminal) assert.ok(step, `nothing to run from "${state}"`);
      else assert.equal(step, null, `"${state}" is terminal and should offer nothing`);
    }
  });

  test('the quickfix route is not sent into planning', async () => {
    const { nextStep } = await import('../lib/state.js');

    // The one answer that depends on the route. Sending a quickfix to /pd:plan
    // is what `pdkit issue escalate` exists to undo, and it would be handed out
    // by the machine rather than chosen by anybody.
    assert.equal(nextStep({ issue: 42, state: 'triaged', route: 'quickfix' }), '/pd:quickfix 42');
    assert.equal(nextStep({ issue: 42, state: 'triaged', route: 'standard' }), '/pd:plan 42');
  });

  test('plan-approved names exec, which is the state name that is not the command name', async () => {
    const { nextStep } = await import('../lib/state.js');

    // The regression this whole describe block exists for.
    assert.equal(nextStep({ issue: 18832, state: 'plan-approved', route: 'standard' }), '/pd:exec 18832');
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

      // Digits belong in the name: `e2e` is a command, and a pattern that
      // stopped at the first digit reported it as the non-existent `pdkit e`.
      for (const [, command] of codeOnly(text).matchAll(/\bpdkit ([a-z][a-z0-9-]*)/g)) {
        if (!COMMANDS.includes(command)) problems.push(`${entry}: pdkit ${command}`);
      }
    }

    assert.deepEqual(problems, [], `these skills name commands pdkit does not have:\n  ${problems.join('\n  ')}`);
  });

  test('the dispatcher and the exported list agree', async () => {
    const { COMMANDS, REGISTRY } = await import('../lib/cli.js');

    // `version` is answered before the dispatcher, since --version has to work
    // without a command at all — but through its own row, so it needs a run too.
    for (const command of COMMANDS) {
      assert.equal(typeof REGISTRY[command]?.run, 'function', `COMMANDS lists "${command}" but nothing in the dispatcher handles it`);
    }
  });

  test('every dispatched command is in the exported list', async () => {
    const { COMMANDS, REGISTRY } = await import('../lib/cli.js');
    const source = await readFile(join(ROOT, 'lib', 'cli.js'), 'utf8');

    for (const command of Object.keys(REGISTRY)) {
      assert.ok(COMMANDS.includes(command), `the dispatcher handles "${command}", which COMMANDS does not list`);
    }

    // The dispatcher is a lookup in REGISTRY and nothing else. A `case` arm in
    // main would be a command handled outside the registry, and so outside the
    // list. The sub-commands of gate and issue are dispatched in lib/commands/,
    // not in main.
    const main = code(source.slice(source.indexOf('export async function main(')));
    assert.ok(!/^\s*case '/m.test(main), 'main dispatches a command outside the registry');
  });
});

// The unknown-flag check is only as good as its table, and a table kept by hand
// beside the code it describes is a table that falls behind. Both halves of the
// drift are checked here rather than in a behaviour test, because neither is
// about what a command does: one is about a command having a row at all, the
// other about a handler reading a flag nobody declared.
//
// The second is the one that matters. A handler that gains a flag while the
// table does not is a flag the dispatcher refuses before the handler ever sees
// it — a working feature made unreachable, and by the check that exists to stop
// exactly that kind of silence.
describe('the flag table describes the commands', () => {
  /** The names in `flags.x` and `flags['x']`, from source with comments cut. */
  function flagsRead(source) {
    const stripped = code(source);
    return new Set([
      ...[...stripped.matchAll(/flags\.([A-Za-z_][\w]*)/g)].map((match) => match[1]),
      ...[...stripped.matchAll(/flags\['([^']+)'\]/g)].map((match) => match[1]),
    ]);
  }

  /** Where handlers live: the dispatcher, and the command modules it imports. */
  async function handlerSource() {
    const commands = (await modules(join(LIB, 'commands'))).map((entry) => entry.source);
    return [await readFile(join(LIB, 'cli.js'), 'utf8'), ...commands].join('\n');
  }

  test('every command the dispatcher accepts has a row', async () => {
    const { COMMANDS, COMMAND_FLAGS } = await import('../lib/cli.js');

    // `hook` is exempt from the check and therefore from the table: it is
    // invoked by the host, and refusing an argument a future host adds would
    // take the gate down to report a typo nobody made.
    const missing = COMMANDS.filter((command) => command !== 'hook' && !(command in COMMAND_FLAGS));

    assert.deepEqual(missing, []);
  });

  test('and names no command the dispatcher does not', async () => {
    const { COMMANDS, COMMAND_FLAGS } = await import('../lib/cli.js');
    const stale = Object.keys(COMMAND_FLAGS).filter((command) => !COMMANDS.includes(command));

    assert.deepEqual(stale, []);
  });

  test('every flag any handler reads is declared somewhere', async () => {
    const { COMMAND_FLAGS, GLOBAL_FLAGS } = await import('../lib/cli.js');
    const source = await handlerSource();

    const declared = new Set([...Object.values(COMMAND_FLAGS).flat(), ...GLOBAL_FLAGS, 'version']);
    const undeclared = [...flagsRead(source)].filter((name) => !declared.has(name)).sort();

    assert.deepEqual(undeclared, [], 'a handler reads a flag the dispatcher will refuse before it arrives');
  });

  test('and no row declares a flag nothing reads', async () => {
    const { COMMAND_FLAGS } = await import('../lib/cli.js');
    const read = flagsRead(await handlerSource());

    const unread = [...new Set(Object.values(COMMAND_FLAGS).flat())].filter((name) => !read.has(name)).sort();

    assert.deepEqual(unread, [], 'a declared flag nothing reads is accepted and then ignored, which is where this started');
  });

  // Somewhere is not enough once a command has a file of its own: a flag read
  // in one module and declared on another command's row passes the check above
  // and is refused on the command that reads it.
  test('a command module reads only the flags it declares', async () => {
    const { GLOBAL_FLAGS } = await import('../lib/cli.js');
    const undeclared = [];

    for (const entry of await modules(join(LIB, 'commands'))) {
      if (entry.name === 'support.js') continue;
      const { flags } = await import(`../lib/commands/${entry.name}`);
      for (const name of flagsRead(entry.source)) {
        if (!flags.includes(name) && !GLOBAL_FLAGS.includes(name)) undeclared.push(`${entry.name}: --${name}`);
      }
    }

    assert.deepEqual(undeclared.sort(), [], 'a command module reads a flag its own row does not declare');
  });
});

// The suite has to actually run on every platform CI claims to cover, and one
// character decided whether it did.
//
// `node --test 'test/*.test.js'` expands the pattern in node, not in the shell —
// single quotes stop a POSIX shell globbing it, which is what made the form look
// correct. cmd.exe does not treat `'` as a quote at all, so the Windows runner
// passed node the pattern with the quotes still attached, node matched no files,
// and the job reported success having run **zero** tests. Green for as long as
// the repository had CI.
//
// That is the failure this codebase keeps meeting from different directions: a
// run that executed nothing is not a green run. It is why `e2e-stability` counts
// tests rather than trusting an exit code, and why section 13 requires an
// artefact to remove a row rather than an absence of complaints.
describe('the suite runs where CI says it runs', () => {
  test('the test script uses no single quotes, which cmd.exe does not strip', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

    assert.doesNotMatch(
      pkg.scripts.test,
      /'/,
      'single quotes reach node as part of the pattern on Windows, so it matches nothing and exits 0',
    );
  });

  test('and names a pattern that matches the suite', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const pattern = /--test\s+"?([^"\s]+)"?/.exec(pkg.scripts.test)?.[1];

    assert.ok(pattern, `no test pattern in "${pkg.scripts.test}"`);

    // Resolved the way node resolves it, so a pattern that has drifted from the
    // directory layout fails here rather than by running nothing.
    const [dir, file] = [dirname(pattern), basename(pattern)];
    const found = (await readdir(join(ROOT, dir))).filter((name) =>
      new RegExp(`^${file.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(name),
    );

    assert.ok(found.length > 0, `${pattern} matches no files`);
  });
});

// A dynamic import of a path this code built must go through pathToFileURL.
//
// The bug this replaces had been in `bin/pdkit` since the first commit and was
// invisible for a month, because a POSIX absolute path works as an import
// specifier by accident: it starts with `/`, which is a valid URL path. A
// Windows path starts with `D:`, which ESM reads as an unsupported scheme and
// refuses — so every `pdkit` invocation on Windows died at the entry point,
// uncaught, exit 1. The gate did not refuse there; it never ran.
//
// Three sites had it: the entry point, the hook handler loader, and the
// preflight check loader. Nothing caught it because the only platform that can
// see it was the platform whose CI job was silently running zero tests.
describe('dynamic imports are URLs, not paths', () => {
  test('every await import() of a built path goes through pathToFileURL', async () => {
    const sources = [...(await modules()), { name: 'bin/pdkit', code: code(await readFile(join(ROOT, 'bin', 'pdkit'), 'utf8')) }];

    const offenders = [];
    for (const module of sources) {
      for (const [call] of module.code.matchAll(/await import\([^)]*\)/g)) {
        // A relative specifier is fine and is the common case; what cannot be
        // handed to import() raw is something join/resolve produced.
        const built = /\b(join|resolve)\s*\(/.test(call);
        if (built && !call.includes('pathToFileURL')) offenders.push(`${module.name}: ${call}`);
      }
    }

    assert.deepEqual(offenders, [], 'these refuse to load on Windows, where a path is not a URL');
  });
});

// `--help` is the one description of the commands a person reads, and it is
// text: USAGE in lib/cli.js is laid out by hand, so nothing derives it from
// REGISTRY or from a command's ACTIONS. A command or an action added without a
// line there passes every behaviour test and is invisible to everybody who
// asks pdkit what it can do. Adding an action is three edits — the function,
// its row in ACTIONS, its line in USAGE — and this holds the third.
describe('--help names every command and every action', () => {
  /** What `pdkit --help` prints, from the entry point a person runs. */
  async function help() {
    const { stdout } = await promisify(execFile)(process.execPath, [join(ROOT, 'bin', 'pdkit'), '--help']);
    return stdout;
  }

  // Descriptions start in this column; what is left of it is the synopsis.
  const DESCRIPTION = 32;

  /**
   * The synopses of one command in USAGE: every entry that starts with
   * `  <command> `, and the indented lines that continue it, up to the next
   * entry — without the description column.
   *
   * Prose is left out because it names actions in passing: `task sync` says
   * "start, receipt write and the hook refuse it", and with prose counted,
   * nine actions were still found after their own lines were deleted.
   *
   * @param {string} usage
   * @param {string} command
   * @returns {string}
   */
  function synopsesOf(usage, command) {
    const found = [];
    let inside = false;
    for (const line of usage.split('\n')) {
      if (/^ {2}\S/.test(line)) inside = line.startsWith(`  ${command} `) || line === `  ${command}`;
      else if (!/^ {3}/.test(line)) inside = false;
      if (!inside || line.startsWith(' '.repeat(DESCRIPTION))) continue;
      // A synopsis too long for its column takes the whole line, and its
      // description starts on the next one.
      const described = line.length > DESCRIPTION && line.slice(DESCRIPTION - 2, DESCRIPTION) === '  ';
      found.push(described ? line.slice(0, DESCRIPTION) : line);
    }
    return found.join('\n');
  }

  test('every command in COMMANDS has an entry', async () => {
    const { COMMANDS } = await import('../lib/cli.js');
    const usage = await help();

    const missing = COMMANDS.filter((command) => !new RegExp(`^  ${command}\\b`, 'm').test(usage));

    assert.deepEqual(missing, [], `pdkit --help says nothing about: ${missing.join(', ')}. Add a line for each to USAGE in lib/cli.js`);
  });

  test("every action in a command's ACTIONS is named in that command's synopsis", async () => {
    const { REGISTRY } = await import('../lib/cli.js');
    const usage = await help();

    const tables = Object.entries(REGISTRY).filter(([, module]) => module.ACTIONS);
    // The table is what dispatches, so a command that has one and does not
    // export it is a command this test silently stops covering.
    assert.ok(tables.length >= 9, `only ${tables.length} command modules export ACTIONS; a table that is not exported is not checked here`);

    const missing = [];
    for (const [command, { ACTIONS }] of tables) {
      const synopses = synopsesOf(usage, command);
      for (const action of Object.keys(ACTIONS)) {
        // Neither a word character nor a hyphen on either side: `block` is not
        // found inside `draft-blocker`, and `slice` is not found in `--slice`.
        const named = new RegExp(`(^|[^\\w-])${action.replace(/[-]/g, '\\-')}($|[^\\w-])`).test(synopses);
        if (!named) missing.push(`pdkit ${command} ${action}`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `ACTIONS dispatches these, and pdkit --help does not name them:\n  ${missing.join('\n  ')}\n` +
        'Add a line for each under its command in USAGE in lib/cli.js.',
    );
  });
});

/**
 * Source with comments, template text and regex bodies blanked, and quoted
 * strings kept — the strings are where the specifiers are.
 *
 * `code` above is a pair of regular expressions, which is enough for finding a
 * file name in code but not for finding imports: `templates/*.md` in a line
 * comment opens a block comment for it, and the imports below that line
 * vanish. This walks the source once and knows which of the four it is in.
 * Newlines are kept, so `^` still means the start of a line.
 *
 * @param {string} source
 * @returns {string}
 */
function lexed(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  // After one of these, `/` starts a regular expression rather than dividing.
  const beforeRegex = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await))\s*$/;
  // One entry per open `${`: how many `{` inside it are still open.
  const templates = [];
  let out = '';
  let i = 0;

  const template = () => {
    // From just after a backtick or a closing `}`, to the end of the text or
    // the next `${`.
    let text = '';
    while (i < source.length && source[i] !== '`' && !(source[i] === '$' && source[i + 1] === '{')) {
      if (source[i] === '\\') text += source[i++];
      text += source[i++] ?? '';
    }
    out += blank(text);
    if (source[i] === '`') out += source[i++];
    else if (i < source.length) {
      out += '${';
      i += 2;
      templates.push(0);
    }
  };

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== char && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (char === '`') {
      out += char;
      i += 1;
      template();
    } else if (char === '/' && beforeRegex.test(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j += 1;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j += 1;
      }
      out += `/${blank(source.slice(i + 1, j))}/`;
      i = j + 1;
    } else if (templates.length > 0 && char === '{') {
      templates[templates.length - 1] += 1;
      out += char;
      i += 1;
    } else if (templates.length > 0 && char === '}') {
      out += char;
      i += 1;
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        template();
      } else templates[templates.length - 1] -= 1;
    } else {
      out += char;
      i += 1;
    }
  }

  return out;
}

/**
 * The relative specifiers a module loads: static `import … from`, bare
 * `import '…'`, `export … from`, and `await import('…')` with a literal.
 *
 * Read from lexed source, so a JSDoc type such as
 * `{import('../slice.js').Graph}` is not an import: it loads nothing. A
 * dynamic import of a built path is not here either — what it loads is decided
 * at run time, and the URL test above already holds those to a known shape.
 *
 * @param {{name: string, source: string}} module path relative to the repository, with `/`
 * @returns {{static: string[], dynamic: string[]}} paths relative to the repository
 */
function importsOf(module) {
  const resolve = (specifier) => posix.normalize(posix.join(posix.dirname(module.name), specifier));
  const relative = (specifier) => specifier.startsWith('.');
  const text = lexed(module.source);

  const statics = [
    ...text.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/gm),
    ...text.matchAll(/^[ \t]*import\s*(['"])([^'"]+)\1/gm),
  ].map((match) => match[2]);
  const dynamics = [...text.matchAll(/await\s+import\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]);

  return {
    static: statics.filter(relative).map(resolve),
    dynamic: dynamics.filter(relative).map(resolve),
  };
}

/** Every .js file under lib/, named from the repository root. */
const libModules = () => modules(LIB, 'lib');

// A facade with `deps` is the permanent API of its package, not a step on the
// way to importing the submodules directly: the wrappers that hand a submodule
// access to the owned file exist only in the facade, so importing the submodule
// instead gets the function without what makes it safe to call. And a
// submodule that imports its facade is a cycle in the making, since the facade
// imports it. The preflight checks are the same shape one level down: a check
// that imports the runner is loaded by the module it depends on.
//
// The rule is for the code that ships. A test may import a submodule to test
// it where it lives — test/state.test.js holds the shape of ENTRY_RULES that
// way — since a test calls nothing through it on anybody's behalf.
describe("a package's submodules are private to it", () => {
  const PACKAGES = ['slice', 'validation', 'state'];

  test('lib/slice/*, lib/validation/*, lib/state/* are imported only by their facade and their siblings', async () => {
    const offenders = [];
    for (const module of await libModules()) {
      const { static: statics, dynamic } = importsOf(module);
      for (const target of [...statics, ...dynamic]) {
        const owner = PACKAGES.find((name) => posix.dirname(target) === `lib/${name}`);
        if (!owner) continue;
        const inside = module.name === `lib/${owner}.js` || posix.dirname(module.name) === `lib/${owner}`;
        if (!inside) offenders.push(`${module.name} imports ${target}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these reach past a facade into its package:\n  ${offenders.join('\n  ')}\n` +
        'Import from lib/slice.js, lib/validation.js or lib/state.js instead; if the facade does not export it, ' +
        'export it there — the facade decides what the package offers.',
    );
  });

  test('no submodule imports its own facade', async () => {
    const offenders = [];
    for (const module of await libModules()) {
      const owner = PACKAGES.find((name) => posix.dirname(module.name) === `lib/${name}`);
      if (!owner) continue;
      const { static: statics, dynamic } = importsOf(module);
      if ([...statics, ...dynamic].includes(`lib/${owner}.js`)) offenders.push(`${module.name} imports lib/${owner}.js`);
    }

    assert.deepEqual(
      offenders,
      [],
      `these import the facade that imports them:\n  ${offenders.join('\n  ')}\n` +
        'Import the function from the leaf sibling it lives in (lib/slice/graph.js, lib/validation/verdict.js, ' +
        'lib/state/machine.js, …), or have the facade pass it in through deps if it touches the owned file.',
    );
  });

  test('no preflight check imports the runner', async () => {
    const offenders = (await modules(join(LIB, 'preflight', 'checks'), 'lib/preflight/checks'))
      .filter((module) => {
        const { static: statics, dynamic } = importsOf(module);
        return [...statics, ...dynamic].includes('lib/preflight/index.js');
      })
      .map((module) => module.name);

    assert.deepEqual(
      offenders,
      [],
      `these checks import lib/preflight/index.js, which loads them:\n  ${offenders.join('\n  ')}\n` +
        'What a check needs from the runner lives in a leaf module beside it (lib/preflight/body.js); import it from there.',
    );
  });
});

// A static cycle is visible to anyone who draws the graph. One closed through
// `await import()` is not: the import runs after both modules have loaded, so
// it works, and nothing that reads only the static graph sees it. lib/state.js
// has three, each documented where it is: highestOnDisk reads the slice graph
// and the validation record so a fresh ID cannot collide with a live one, and
// the amendment parser lives in artefacts.js. A fourth should be a decision
// made on purpose, so it has to be written down here.
describe('no new cycle hides behind a dynamic import', () => {
  const HIDDEN = ['lib/state.js -> lib/artefacts.js', 'lib/state.js -> lib/slice.js', 'lib/state.js -> lib/validation.js'];

  /** The static import graph of lib/: module -> the modules it imports. */
  async function graph() {
    const lib = await modules(LIB, 'lib');
    return {
      lib,
      edges: new Map(lib.map((module) => [module.name, importsOf(module).static.filter((target) => target.startsWith('lib/'))])),
    };
  }

  /** Whether `to` is reached from `from` along static imports. */
  function reaches(edges, from, to) {
    const seen = new Set();
    const queue = [from];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(edges.get(next) ?? []));
    }
    return false;
  }

  test('lib/ has no static import cycle', async () => {
    const { edges } = await graph();

    const cycles = [];
    for (const [module, targets] of edges) {
      for (const target of targets) {
        if (reaches(edges, target, module)) cycles.push(`${module} -> ${target}`);
      }
    }

    assert.deepEqual(
      cycles,
      [],
      `each of these imports a module that imports it back:\n  ${cycles.join('\n  ')}\n` +
        'Move what both need into a leaf module that imports neither.',
    );
  });

  test('the only dynamic imports that close a cycle are the three in lib/state.js', async () => {
    const { lib, edges } = await graph();

    const hidden = [];
    for (const module of lib) {
      for (const target of importsOf(module).dynamic) {
        if (reaches(edges, target, module.name)) hidden.push(`${module.name} -> ${target}`);
      }
    }

    assert.deepEqual(
      [...new Set(hidden)].sort(),
      HIDDEN,
      'a dynamic import closes a cycle the static graph cannot see. Break it with a leaf module; if it cannot be broken, ' +
        'say why in a comment at the import and add the pair to HIDDEN in test/invariants.test.js.',
    );
  });
});

describe('licensing', () => {
  // The house format, stated here in full rather than sampled from a file that
  // happens to carry it. knowledge/upstream-rules.md tells contributors that a
  // bare `// SPDX-License-Identifier: Apache-2.0` is *not* the format podman-
  // desktop accepts, and preflight fails a pull request that ships one. A
  // repository that says that while carrying the short form itself is the kind
  // of detail a reviewer notices first and trusts least afterwards.
  const HEADER = `/**********************************************************************
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
`;

  test('every module carries the header in full', async () => {
    const missing = (await modules())
      .filter((module) => !module.source.startsWith(HEADER))
      .map((module) => module.name);

    assert.deepEqual(missing, []);
  });

  test('the entry point carries it under the shebang', async () => {
    const source = await readFile(join(ROOT, 'bin', 'pdkit'), 'utf8');

    // Order matters and only one way round works: a header above `#!` leaves a
    // file the kernel will not execute, and the plugin puts bin/ on PATH.
    assert.ok(source.startsWith('#!/usr/bin/env node\n'), 'the shebang is not first');
    assert.ok(source.startsWith(`#!/usr/bin/env node\n${HEADER}`), 'the header does not follow the shebang');
  });
});

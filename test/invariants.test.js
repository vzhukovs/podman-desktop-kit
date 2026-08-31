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
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

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
      ...['specification.md', 'workflows.md', 'architecture.md', 'configuration.md'].map((name) => join(ROOT, 'docs', name)),
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
    for (const [, command] of body.matchAll(/^\s{6}case '([a-z0-9-]+)':/gm)) {
      assert.ok(COMMANDS.includes(command), `the dispatcher handles "${command}", which COMMANDS does not list`);
    }
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
    const source = await readFile(join(LIB, 'cli.js'), 'utf8');

    const declared = new Set([...Object.values(COMMAND_FLAGS).flat(), ...GLOBAL_FLAGS, 'version']);
    const undeclared = [...flagsRead(source)].filter((name) => !declared.has(name)).sort();

    assert.deepEqual(undeclared, [], 'a handler reads a flag the dispatcher will refuse before it arrives');
  });

  test('and no row declares a flag nothing reads', async () => {
    const { COMMAND_FLAGS } = await import('../lib/cli.js');
    const read = flagsRead(await readFile(join(LIB, 'cli.js'), 'utf8'));

    const unread = [...new Set(Object.values(COMMAND_FLAGS).flat())].filter((name) => !read.has(name)).sort();

    assert.deepEqual(unread, [], 'a declared flag nothing reads is accepted and then ignored, which is where this started');
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

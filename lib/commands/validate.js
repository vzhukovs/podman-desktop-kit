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

// `pdkit validate`: bring the application up, attach evidence, close it out.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { join } from 'node:path';

import { get, paths, resolveHome } from '../config.js';
import * as evidence from '../evidence.js';
import { pickScript, scripts as repoScripts } from '../repo.js';
import * as validation from '../validation.js';
import { EXIT, describeRun, printJson, repoContext, requireIssueTree } from './support.js';

export const flags = ['issue', 'build', 'port', 'title', 'run', 'evidence', 'expected', 'observed', 'requirement', 'spec', 'by', 'reason'];

const ACTIONS = {
  steps,
  launch,
  stop,
  attach,
  supersede,
  codify,
  run: runSpec,
  finish,
};

/**
 * Validation: bring the application up, attach evidence, close it out.
 *
 * Note what has no flag: the status of a step. `--run` and `--evidence` are the
 * only ways a step gets one, and both produce it from something that happened
 * (spec section 2.2, invariant 5).
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const [subcommand] = args;
  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);

  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit validate: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });
  const stabilityRuns = Number(get(repo.config, 'validation.e2e_stability_runs') ?? 3);

  // The subcommands that build, launch or run something in the tree. Evidence
  // gathered from another issue's build is evidence about that issue, filed
  // under this one. The rest only read and write the issue's own record.
  const touchesTree = ['launch', 'codify', 'run'].includes(subcommand) || (subcommand === 'attach' && typeof flags.run === 'string');
  if (touchesTree && repo.root) {
    const held = await requireIssueTree({ issue, repo, command: `pdkit validate ${subcommand}`, words: ['validate', ...args], flags });
    if (!held.ok) return EXIT.ERROR;
  }

  const handler = Object.hasOwn(ACTIONS, subcommand) ? ACTIONS[subcommand] : unknown;
  return handler({ args, issue, repo, home, stabilityRuns }, flags);
}

async function steps({ issue, repo, home }, flags) {
  const waiting = await validation.steps({ issue, home, repoRoot: repo.root ?? undefined });
  if (flags.json) printJson(waiting);
  else {
    process.stdout.write(`validate: issue ${issue} — ${waiting.state}${waiting.route ? `, ${waiting.route}` : ''}\n`);
    process.stdout.write(`  requirements : ${waiting.requirements.join(', ') || '—'}\n`);
    process.stdout.write(`  e2e coverage : ${waiting.e2eCoverage ?? 'no plan says'}\n\n`);
    for (const task of waiting.tasks) {
      process.stdout.write(`  ${task.id} ${task.title}\n      satisfies ${task.satisfies.join(', ') || '—'}\n`);
      if (task.command) process.stdout.write(`      done when \`${task.command}\`\n`);
    }
    process.stdout.write(`\n${validation.format(waiting.record)}\n`);
  }
  return EXIT.OK;
}

async function launch({ issue, repo, home }, flags) {
  if (!repo.root) {
    process.stderr.write(`pdkit validate launch: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  // Before the build, so a refusal costs nothing.
  const app = validation.trustedApp(repo.root);
  if (app.error) {
    process.stderr.write(`pdkit validate launch: ${app.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.build) {
    const script = pickScript(await repoScripts(repo.root), ['build']);
    if (!script) {
      process.stderr.write('pdkit validate launch: --build was asked for, and this repository has no build script\n');
      return EXIT.ERROR;
    }
    const command = `${get(repo.config, 'repo.package_manager') ?? 'pnpm'} run ${script}`;
    process.stderr.write(`  building: ${command}\n`);
    const built = await evidence.capture({ command, cwd: repo.root, timeoutMs: 30 * 60 * 1000 });
    if (built.exitCode !== 0) {
      process.stderr.write(`${built.stdout}${built.stderr}\npdkit validate launch: the build failed; there is nothing to drive\n`);
      return EXIT.ERROR;
    }
  }

  const port = Number.parseInt(String(flags.port), 10);
  const launched = await validation.launch({
    issue,
    home,
    repoRoot: repo.root,
    config: repo.config,
    app,
    port: Number.isInteger(port) ? port : undefined,
  });

  if (!launched.ok) {
    process.stderr.write(`pdkit validate launch: ${launched.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson(launched.app);
  else {
    process.stdout.write(
      `${launched.alreadyRunning ? 'already running' : 'started'}: pid ${launched.app.pid}, CDP at ${launched.app.endpoint}\n` +
        '  Playwright MCP attaches to this endpoint (--cdp-endpoint). pdkit does not connect to it.\n' +
        // Measured, 3 restarts out of 3: the server holds the page of the
        // application it first saw, and the call after a relaunch comes back
        // "Target page, context or browser has been closed". The one after
        // that succeeds. Said here because the error names nothing that is
        // actually wrong, and reads as "the app did not start".
        (launched.relaunch
          ? '  Relaunched: the first Playwright call after this will fail once with "Target page, context or\n' +
            '  browser has been closed". That is the server letting go of the old window — call it again.\n'
          : ''),
    );
  }
  return EXIT.OK;
}

async function stop({ issue, repo, home }) {
  const stopped = await validation.stop({ issue, home, config: repo.config });
  if (!stopped.ok) {
    process.stderr.write(`pdkit validate stop: ${stopped.error}\n`);
    return EXIT.ERROR;
  }
  process.stdout.write(stopped.stopped ? 'stopped\n' : 'nothing was running\n');
  return EXIT.OK;
}

async function attach({ issue, repo, home }, flags) {
  const command = typeof flags.run === 'string' ? flags.run : null;
  const run = command ? await evidence.capture({ command, cwd: repo.root ?? process.cwd() }) : null;

  const attached = await validation.attach({
    issue,
    home,
    repoRoot: repo.root ?? undefined,
    title: typeof flags.title === 'string' ? flags.title : '',
    // `--requirement R1 --requirement R2`, and `--requirement "R1, R2"`. A
    // step usually demonstrates two or three, and naming only one meant the
    // rest were described in prose and traced by nobody.
    requirements: validation.requirementsOf(/** @type {string|string[]} */ (flags.requirement)),
    expected: typeof flags.expected === 'string' ? flags.expected : null,
    observed: typeof flags.observed === 'string' ? flags.observed : null,
    evidence: typeof flags.evidence === 'string' ? flags.evidence : null,
    run,
  });

  if (!attached.ok) {
    process.stderr.write(`pdkit validate attach: ${attached.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson(attached.step);
  else {
    process.stdout.write(`${attached.step.id} ${validation.statusOf(attached.step)} — ${attached.step.title}\n`);
    if (attached.step.evidence) process.stdout.write(`  evidence: ${attached.step.evidence.path}\n`);
    else process.stdout.write('  no artefact, so this step is unverified. Say so in Notes for reviewers\n');
  }
  return EXIT.OK;
}

async function supersede({ args, issue, home }, flags) {
  const superseded = await validation.supersede({
    issue,
    home,
    step: typeof args[1] === 'string' && /^V\d+$/i.test(args[1]) ? args[1].toUpperCase() : '',
    by: typeof flags.by === 'string' ? flags.by.toUpperCase() : '',
    reason: typeof flags.reason === 'string' ? flags.reason : '',
  });

  if (!superseded.ok) {
    process.stderr.write(`pdkit validate supersede: ${superseded.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson(superseded);
  else {
    process.stdout.write(
      `${superseded.step.id} is set aside for ${superseded.by.id} — ${superseded.step.title}\n` +
        `  it stays in validation.md with its run and this reason; it no longer counts towards the outcome\n`,
    );
    // The one thing this command can lose, said out loud at the moment it
    // happens rather than found later in a coverage table.
    if (superseded.note) process.stdout.write(`  ${superseded.note}\n`);
  }
  return EXIT.OK;
}

async function codify({ issue, repo, home }, flags) {
  if (!repo.root || typeof flags.spec !== 'string') {
    process.stderr.write('pdkit validate codify: --spec <path> is required\n');
    return EXIT.ERROR;
  }

  const codified = await validation.codify({ issue, home, repoRoot: repo.root, spec: flags.spec });
  if (!codified.ok) {
    process.stderr.write(`pdkit validate codify: ${codified.error}\n`);
    return EXIT.ERROR;
  }

  process.stdout.write(`${codified.record.e2e.spec}\n  digest ${codified.digest}\n`);
  return EXIT.OK;
}

async function runSpec({ issue, repo, home }, flags) {
  if (!repo.root) {
    process.stderr.write(`pdkit validate run: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const ran = await validation.runSpec({
    issue,
    home,
    repoRoot: repo.root,
    config: repo.config,
    spec: typeof flags.spec === 'string' ? flags.spec : undefined,
    requirements: validation.requirementsOf(/** @type {string|string[]} */ (flags.requirement)),
  });

  if (!ran.ok) {
    process.stderr.write(`pdkit validate run: ${ran.error}\n`);
    return EXIT.ERROR;
  }

  // The step's evidence file is the capture, whole. What is printed is the
  // path to it, and the tail when it is red — see describeRun.
  process.stdout.write(`${ran.step.id} ${validation.statusOf(ran.step)}\n`);
  process.stdout.write(
    describeRun({ path: join(paths(home).issues, String(issue), ran.step.evidence.path), run: ran.run, digest: ran.step.evidence.digest }),
  );
  // A red run is recorded and reported; it is a fact about the change, and
  // the exit code says so without discarding the evidence.
  return ran.exitCode === 0 ? EXIT.OK : EXIT.ERROR;
}

async function finish({ issue, home, stabilityRuns }, flags) {
  const finished = await validation.finish({ issue, home, stabilityRuns });

  if (flags.json) printJson(finished);
  else {
    process.stdout.write(`${validation.format(await validation.read(issue, { home }))}\n`);
    if (finished.path) process.stdout.write(`\n  written: ${finished.path}\n`);
    if (finished.moved) process.stdout.write('  issue moved to validated\n');
    if (finished.note) process.stdout.write(`  state unchanged: ${finished.note}\n`);
  }

  if (!finished.ok) {
    process.stderr.write(`pdkit validate finish: ${finished.error}\n`);
    return EXIT.ERROR;
  }
  return EXIT.OK;
}

async function unknown() {
  process.stderr.write(`pdkit validate: ${Object.keys(ACTIONS).join(' | ')}\n`);
  return EXIT.ERROR;
}

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

// `pdkit plan`: the mechanical half of a plan review — the shape check, the
// run of every `Done when` before code exists, the plan's tasks by area, the
// snapshot of the plan a round reads and what changed since, the brief the
// critic is handed, and the record that a review's decisions reached the plan;
// and what the reviews of earlier, archived attempts raised.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readAmendments } from '../amendment.js';
import { checkPlan, parsePlan } from '../artefacts.js';
import { paths, resolveHome } from '../config.js';
import * as criticBrief from '../critic-brief.js';
import { planAreas } from '../plan-areas.js';
import * as planLessons from '../plan-lessons.js';
import * as planReview from '../plan-review.js';
import * as planRevision from '../plan-revision.js';
import * as planRounds from '../plan-rounds.js';
import * as pr from '../pr.js';
import * as probe from '../probe.js';
import * as state from '../state.js';
import { EXIT, printJson, repoContext, treeOf } from './support.js';

export const flags = ['task', 'except', 'amendment', 'mode', 'area', 'axis'];

export const ACTIONS = {
  check,
  probe: runProbe,
  areas,
  snapshot,
  diff,
  brief,
  revised,
  lessons,
};

/**
 * The mechanical half of a plan review.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  if (!Object.hasOwn(ACTIONS, args[0] ?? '')) {
    process.stderr.write(`pdkit plan: unknown action "${args[0] ?? ''}" (${Object.keys(ACTIONS).join(', ')})\n`);
    return EXIT.ERROR;
  }
  return ACTIONS[args[0]](args, flags);
}

/**
 * What `plan check` measures, for the two actions that report it.
 *
 * @param {number} issue
 * @returns {Promise<{path: string, plan: import('../artefacts.js').Plan|null, record: Awaited<ReturnType<typeof state.read>>|null, result: Awaited<ReturnType<typeof checkPlan>>|null, written: {at: string, label: string}|null}>}
 *   `plan` and `result` null when there is no plan.md at `path`
 */
async function measure(issue) {
  const path = join(paths(resolveHome()).issues, String(issue), 'plan.md');
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return { path, plan: null, record: null, result: null, written: null };

  const record = await state.read(issue);
  const plan = parsePlan(content);
  const result = await checkPlan({ plan, content, record, probe: await probe.read(issue) });

  // Which plan this verdict is about, and how old it is. `plan.md` is rendered
  // and then edited by hand, and a planning run that fails to persist leaves the
  // previous one in place — after which a green here is a statement about
  // yesterday that reads exactly like one about the plan just written. Measured
  // on 18832: a run whose every write was denied left the superseded plan on
  // disk, and this command reported `passes` for it without naming what it read.
  //
  // The same principle as the base ref in preflight (section 7) and `read:<age>`
  // on the dashboard (section 4): a measurement has to say what it saw. No
  // threshold and no warning — a plan is allowed to be old, and inventing a
  // staleness rule here would price a gate where there is no risk.
  const written = await stat(path)
    .then((entry) => pr.reading({ refreshedAt: entry.mtime.toISOString() }))
    .catch(() => null);

  return { path, plan, record, result, written };
}

/**
 * The report `plan check` prints, without its closing paragraph. The brief
 * carries these same lines, so what the critic is told the check found is what
 * the check prints, and not a second account of it.
 *
 * @param {number} issue
 * @param {Awaited<ReturnType<typeof measure>>} measured
 * @returns {string[]}
 */
function reportLines(issue, measured) {
  const { path, written } = measured;
  const result = /** @type {NonNullable<typeof measured.result>} */ (measured.result);
  return [
    `plan check: issue ${issue} — ${result.ok ? 'passes' : `${result.problems.length} problem(s)`}`,
    ...(written ? [`  plan  ${path}, written ${written.label === 'just now' ? 'just now' : `${written.label} ago`}`] : []),
    ...result.problems.map((problem) => `  ✘ ${problem.check.padEnd(16)} ${problem.detail}`),
    ...result.warnings.map((warning) => `  ! ${warning.check.padEnd(16)} ${warning.detail}`),
  ];
}

async function check(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan check: an issue number is required\n');
    return EXIT.ERROR;
  }

  const measured = await measure(issue);
  const { path, result, written } = measured;
  if (result === null) {
    process.stderr.write(`pdkit plan check: ${path} does not exist\n`);
    return EXIT.ERROR;
  }

  if (flags.json) {
    printJson({ issue, path, writtenAt: written?.at ?? null, writtenAge: written?.label ?? null, ...result });
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  for (const line of reportLines(issue, measured)) process.stdout.write(`${line}\n`);
  process.stdout.write(
    result.ok
      ? '\nThe mechanical checks pass. What is left is the question no grep answers:\nis this task necessary at all, and does something already do it?\n'
      : '\nThese get a plan redone rather than patched.\n',
  );

  return result.ok ? EXIT.OK : EXIT.ERROR;
}

/** A comma list of T-IDs from a flag, or null when the flag is absent. */
function taskList(value) {
  return typeof value === 'string' ? new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean)) : null;
}

/**
 * Run each live task's `Done when` in this tree, and record what it printed.
 *
 * Run from the main checkout, which stays on the base branch: the question is
 * what the command does before any of the plan's code exists. The commands are
 * the plan's — read them first; a probe runs what the plan says, and one
 * planned docs build was a `pnpm --filter` that reinstalled dependencies.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runProbe(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan probe: an issue number is required\n');
    return EXIT.ERROR;
  }

  const home = resolveHome();
  let tasks;
  if (typeof flags.amendment === 'string') {
    const found = (await readAmendments(issue, home)).find((entry) => entry.id === flags.amendment);
    if (!found) {
      process.stderr.write(`pdkit plan probe: issue ${issue} has no amendment ${flags.amendment}\n`);
      return EXIT.ERROR;
    }
    tasks = found.tasks;
  } else {
    const content = await readFile(join(paths(home).issues, String(issue), 'plan.md'), 'utf8').catch(() => null);
    if (content === null) {
      process.stderr.write(`pdkit plan probe: issue ${issue} has no plan.md\n`);
      return EXIT.ERROR;
    }
    const withdrawn = (await state.read(issue)).withdrawn ?? {};
    tasks = parsePlan(content).tasks.filter((task) => !task.replacedBy && !(task.id in withdrawn));
  }

  const only = taskList(flags.task);
  const except = taskList(flags.except) ?? new Set();
  const chosen = tasks.filter((task) => task.command && (!only || only.has(task.id)) && !except.has(task.id));
  const left = tasks.filter((task) => !chosen.includes(task));

  const repo = await repoContext(flags);
  const cwd = repo.root ?? process.cwd();
  const runs = await probe.run({
    issue,
    cwd,
    tasks: chosen.map((task) => ({ id: task.id, command: task.command })),
    onRun: flags.json ? undefined : (entry) => process.stdout.write(`${describeProbe(entry)}\n`),
  });

  if (flags.json) {
    printJson({ issue, cwd, runs, notRun: left.map((task) => task.id) });
    return EXIT.OK;
  }
  if (runs.length > 0) process.stdout.write(`  ran in ${cwd} at ${runs[0].head ?? 'an unknown commit'}${runs[0].dirty ? ' — the tree has tracked changes, so this is not the base' : ''}\n`);
  // Said, not dropped: a task not run is a task with no measurement, and plan
  // check keeps saying so until it has one.
  for (const task of left) {
    process.stdout.write(`  ${task.id}  not run — ${!task.command ? 'no executable Done when' : except.has(task.id) ? '--except' : 'not in --task'}\n`);
  }
  process.stdout.write(
    '\nA non-zero exit before the code exists is often expected — the file under test is not written yet.\n' +
      'Which failures are that, and which are a command that can never pass, is the review\'s question;\n' +
      `\`pdkit plan check ${issue}\` lists them for it.\n`,
  );
  return EXIT.OK;
}

/**
 * One probe run, as a line.
 *
 * @param {import('../probe.js').ProbeRun} entry
 * @returns {string}
 */
function describeProbe(entry) {
  const seconds = Math.round(entry.durationMs / 1000);
  const outcome = !entry.complete ? `incomplete (${entry.incompleteBecause})` : `exit ${entry.exitCode ?? 'none'}`;
  const last = entry.exitCode === 0 ? '' : `  — ${(entry.tail[entry.tail.length - 1] ?? '(no output)').slice(0, 140)}`;
  return `  ${entry.task}  ${outcome}  ${seconds}s${last}`;
}

/**
 * The plan's live tasks by area, with what each waits on and what waits on it.
 *
 * Read-only. Which areas one critic takes is /pd:plan-review's call; this
 * prints what the plan's Owns and After lines say.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function areas(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan areas: an issue number is required\n');
    return EXIT.ERROR;
  }

  const path = join(paths(resolveHome()).issues, String(issue), 'plan.md');
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) {
    process.stderr.write(`pdkit plan areas: ${path} does not exist\n`);
    return EXIT.ERROR;
  }

  const result = planAreas(parsePlan(content), (await state.read(issue)).withdrawn ?? {});
  if (flags.json) {
    printJson({ issue, path, ...result });
    return EXIT.OK;
  }

  const byId = new Map(result.tasks.map((task) => [task.id, task]));
  const width = Math.max(0, ...result.tasks.map((task) => task.id.length));
  process.stdout.write(`plan areas: issue ${issue} — ${result.tasks.length} live task(s) in ${result.areas.length} area(s)\n`);
  for (const area of result.areas) {
    // An edge to a task outside the area names the areas it is in: that is
    // the dependency the area's critic would not otherwise see.
    const inside = new Set(area.tasks.map((task) => task.id));
    const edge = (id) => (inside.has(id) ? id : `${id} (${byId.get(id)?.areas.join(', ') ?? 'not live'})`);
    const list = (ids) => (ids.length > 0 ? ids.map(edge).join(', ') : '—');

    process.stdout.write(`\n${area.name}: ${area.tasks.map((task) => task.id).join(', ')}\n`);
    for (const member of area.tasks) {
      const task = /** @type {import('../plan-areas.js').TaskEdges} */ (byId.get(member.id));
      const elsewhere = task.areas.filter((name) => name !== area.name);
      process.stdout.write(`  ${task.id.padEnd(width)}  ${task.title}\n`);
      member.owns.forEach((entry, at) => process.stdout.write(`      ${at === 0 ? 'owns' : '    '}           ${entry}\n`));
      if (member.owns.length === 0) process.stdout.write('      owns           nothing — a verification\n');
      if (elsewhere.length > 0) process.stdout.write(`      also in        ${elsewhere.join(', ')}\n`);
      process.stdout.write(`      after          ${list(task.after)}\n`);
      process.stdout.write(`      waited on by   ${list(task.waitedOnBy)}\n`);
    }
  }
  if (result.notLive.length > 0) process.stdout.write(`\nnot live, so in no area: ${result.notLive.join(', ')} — replaced or withdrawn\n`);
  return EXIT.OK;
}

/**
 * Copy the plan a review is about to read into `reviews/r<k>/`.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function snapshot(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan snapshot: an issue number is required\n');
    return EXIT.ERROR;
  }

  const result = await planRounds.snapshot(issue);
  if (!result.ok) {
    process.stderr.write(`pdkit plan snapshot: ${result.error}\n`);
    return EXIT.ERROR;
  }
  if (flags.json) {
    printJson({ issue, round: result.round, path: result.path, outcome: result.outcome, files: result.files });
    return EXIT.OK;
  }

  const outcome = {
    taken: 'taken',
    unchanged: 'already taken, and the plan is the same',
    replaced: 'replaced: the plan changed since it was taken, and no review of the round is written yet',
  }[result.outcome];
  process.stdout.write(`plan snapshot: issue ${issue}, round ${result.round} — ${outcome}\n  ${result.path}: plan.md and ${result.files.length - 1} task file(s)\n`);
  return EXIT.OK;
}

/**
 * Which snapshot a diff compared with, in words.
 *
 * @param {import('../plan-rounds.js').PlanDiff} result
 * @returns {string}
 */
function describeBase(result) {
  const base = /** @type {{round: number, path: string}} */ (result.base);
  if (base.round === result.lastRound) return `r${base.round}, the plan round ${base.round} reviewed`;
  if (base.round > result.lastRound) return `r${base.round}, taken for round ${base.round}, which has no review yet`;
  return `r${base.round}, the plan round ${base.round} reviewed — round ${result.lastRound} has no snapshot`;
}

/**
 * The current plan against the snapshot of the plan the last round reviewed.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function diff(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan diff: an issue number is required\n');
    return EXIT.ERROR;
  }

  const result = await planRounds.diff(issue, { withdrawn: (await state.read(issue)).withdrawn ?? {} });
  if (!result.ok) {
    process.stderr.write(`pdkit plan diff: ${result.error}\n`);
    return EXIT.ERROR;
  }
  if (flags.json) {
    const { ok: _ok, ...facts } = result;
    printJson(facts);
    return EXIT.OK;
  }

  if (result.base === null || result.plan === null) {
    process.stdout.write(
      `plan diff: issue ${issue} — no snapshot to compare with in ${planRounds.SNAPSHOTS}/\n` +
        `  A review takes one as it starts: \`pdkit plan snapshot ${issue}\`.\n`,
    );
    return EXIT.OK;
  }

  const none = (list) => (list.length > 0 ? list.join(', ') : 'none');
  const plan = result.plan;
  const lines = [
    `plan diff: issue ${issue} — against ${describeBase(result)}`,
    `  structural   ${result.structural ? `yes — ${result.because.join('; ')}` : 'no'}`,
    `  tasks        added ${none(result.tasks.added)} · removed ${none(result.tasks.removed)} · changed ${none(result.tasks.changed.map((task) => task.id))}`,
    ...result.tasks.changed.flatMap((task) => [
      `  ${task.id.padEnd(12)} ${task.parts.map((entry) => `${entry.part} (${entry.in.join(', ')})`).join('; ')}`,
      `  ${''.padEnd(12)} after ${none(task.neighbors.after)} · waited on by ${none(task.neighbors.waitedOnBy)}${task.neighbors.interfaces.map((entry) => ` · plan.md:${entry.line} with ${none(entry.with)}`).join('')}`,
    ]),
    `  plan         ${Object.entries(planRounds.PLAN_SECTIONS).map(([key, name]) => `${name} ${plan[key] ? 'changed' : 'unchanged'}`).join(' · ')}`,
    `  other        ${none(result.other)}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  if (result.text.total > 0) process.stdout.write(`\n${result.text.lines.join('\n')}\n`);
  if (result.text.total > result.text.lines.length) {
    process.stdout.write(`\n… ${result.text.total - result.text.lines.length} more line(s) of diff not shown; the snapshot is ${result.base.path}\n`);
  }
  return EXIT.OK;
}

/**
 * The brief pd-plan-critic is handed, on stdout.
 *
 * Read-only: it renders and prints, and writes nothing — the brief is the
 * input of one round, and the round's record is the report it produces.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function brief(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan brief: an issue number is required\n');
    return EXIT.ERROR;
  }
  const bare = ['mode', 'area', 'axis'].find((name) => flags[name] === true);
  if (bare) {
    process.stderr.write(`pdkit plan brief: --${bare} needs a value\n`);
    return EXIT.ERROR;
  }

  const measured = await measure(issue);
  if (measured.plan === null) {
    process.stderr.write(`pdkit plan brief: ${measured.path} does not exist\n`);
    return EXIT.ERROR;
  }

  // The issue's tree, where the critic reads the code; outside one, the base
  // commit is read where the command runs and the brief says which that was.
  const repo = await repoContext(flags);
  const tree = await treeOf(issue, repo);
  const cwd = tree.path ?? repo.root;
  // In both modes: a full brief says why the round is not a delta, and a delta
  // brief carries the change.
  const delta = await planRounds.diff(issue, { withdrawn: measured.record?.withdrawn ?? {} });
  const result = await criticBrief.brief({
    issue,
    mode: /** @type {'full'|'delta'} */ (typeof flags.mode === 'string' ? flags.mode : 'full'),
    // `--area a,b` and `--area a --area b` say the same: one critic, two areas.
    area: flags.area === undefined ? null : [flags.area].flat().flatMap((value) => String(value).split(',')).map((name) => name.trim()).filter(Boolean),
    axis: typeof flags.axis === 'string' ? flags.axis : null,
    plan: measured.plan,
    record: measured.record ?? {},
    check: reportLines(issue, measured),
    delta: delta.ok ? delta : null,
    worktree: tree.path ? { path: tree.path } : { error: tree.error ?? 'not found' },
    tree: cwd ? await criticBrief.treeFacts({ cwd, config: repo.config }) : null,
  });

  if (!result.ok) {
    process.stderr.write(`pdkit plan brief: ${result.error}\n`);
    return EXIT.ERROR;
  }

  process.stdout.write(result.text);
  // On stderr, so the brief on stdout stays the brief: a decision line that
  // opens with no verdict is in none of its lists, and that is said.
  for (const { round, decision } of result.unread) {
    process.stderr.write(`note: round ${round} ${decision.id} opens with no verdict, so the brief lists it nowhere: ${decision.text.slice(0, 120)}\n`);
  }
  return EXIT.OK;
}

/**
 * Record that plan.md now carries the latest round of operator decisions, and
 * print what follows and why.
 *
 * The last step of a revision in /pd:plan. Until it runs, `pdkit next` keeps
 * sending a `planned` issue back to /pd:plan. After it, the state machine's
 * rule over what the revision changed names the step: /pd:plan-review again,
 * or the approval, which is the person's to give.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function revised(args) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan revised: an issue number is required\n');
    return EXIT.ERROR;
  }

  const found = await planReview.pending(issue);
  if (found.round === null) {
    process.stderr.write(
      `pdkit plan revised: ${found.path} has no "## Operator decisions" section, so there is no round to mark applied.\n` +
        '  The review records the decisions there; /pd:plan applies them and then runs this.\n',
    );
    return EXIT.ERROR;
  }
  if (!found.pending) {
    process.stdout.write(`round ${found.round} was already marked applied\n`);
    return EXIT.OK;
  }

  await planReview.markRevised(issue, found.round);
  process.stdout.write(`round ${found.round} of the review is in plan.md (${found.items.join(', ') || 'no item IDs named'})\n`);

  // The same line `pdkit next` prints from here, with the reason beside it:
  // a revision that goes to approval is one the person should be able to
  // check before giving it.
  const record = await state.read(issue);
  const context = await planRevision.nextContext(record);
  const step = state.nextStep(record, context);
  if (step) process.stdout.write(`  next: ${step}\n`);
  if (context.revised) process.stdout.write(`  why:  ${state.afterRevision(context.revised).because}\n`);
  return EXIT.OK;
}

/**
 * What the plan reviews of earlier, archived attempts raised, and what was
 * decided on each item. Read-only.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function lessons(args, flags) {
  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan lessons: an issue number is required\n');
    return EXIT.ERROR;
  }

  const result = await planLessons.lessons(issue);
  if (flags.json) {
    printJson(result);
    return EXIT.OK;
  }
  if (!result.found) {
    process.stdout.write(`plan lessons: issue ${issue} — no archived attempt in ${result.archive}\n`);
    return EXIT.OK;
  }

  // Bold markers off, outside code spans only: inside one, `**/test-resources`
  // is a glob, not emphasis.
  const plain = (text) =>
    text
      .split('`')
      .map((part, at) => (at % 2 === 0 ? part.replaceAll('**', '') : part))
      .join('`');
  const lines = [`plan lessons: issue ${issue} — ${result.attempts.length} archived attempt(s) in ${result.archive}`];
  for (const attempt of result.attempts) {
    const when = attempt.archivedAt ? `${attempt.archivedAt.slice(0, 16).replace('T', ' ')} UTC` : 'time unknown';
    lines.push('', `${attempt.dir} — ${attempt.kind}, archived ${when}, ${attempt.reviews.length} review file(s)`);
    for (const review of attempt.reviews) {
      if (review.sameAs) {
        lines.push(`  round ${review.round}  ${review.file}: the same text as ${review.sameAs}`);
        continue;
      }
      lines.push(`  round ${review.round}  ${review.file}${review.items.length === 0 ? ': no A or B item' : ''}`);
      for (const item of review.items) {
        lines.push(`    ${item.id.padEnd(4)}${item.title === null ? '(no heading in the report)' : plain(item.title)}`);
        if (item.decisions.length === 0) lines.push('        no decision line');
        for (const decision of item.decisions) {
          // A line that opens with its verdict says it; one decided by the
          // heading it is under, or by nothing, gets the verdict in front.
          const verdict = decision.by === 'line' ? '' : `${decision.by === 'none' ? 'no verdict' : decision.verdict} — `;
          lines.push(`        ${verdict}${plain(decision.text)}`);
          for (const more of decision.more) lines.push(`          ${plain(more)}`);
        }
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT.OK;
}

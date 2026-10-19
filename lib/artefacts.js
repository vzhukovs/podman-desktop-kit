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

// Reading back what render.js wrote.
//
// One module for both plan.md and tasks/T*.md because it is one concern: the
// templates define a shape, and something has to hold the other half of that
// contract. Splitting it would put half the shape in one file and half in
// another, which is how a template gains a field nothing reads.
//
// checkPlan lives here for the same reason. The mechanical failures of a plan —
// tasks sharing files, `Done when` written as prose, a requirement with no task
// — are properties of the parsed shape, and section 4 puts them in code
// deliberately: an Opus asked to intersect two lists of paths is an Opus that
// can fail to. What is left for pd-plan-critic is the question no grep answers,
// which is whether the task should exist at all.

import { matches } from './globs.js';
import { validateSections } from './render.js';

/**
 * `### T1: title` inside a plan, or `### T5 (replaces T2 and T3): title`.
 *
 * The parenthesis is how an amendment says which tasks a new one takes over
 * from, and it is how A1 on 18915 wrote both of its tasks. The heading without
 * it was the only shape read, so T5 and T6 were not tasks to anything: plan.md
 * carried them and `plan check` still said R7 had no task.
 */
const PLAN_TASK = /^###[ \t]+(T\d+)(?:[ \t]*\(([^)]*)\))?[ \t]*:[ \t]*(.*)$/;

/** Something that starts like a task heading, to name one PLAN_TASK did not read. */
const TASK_LIKE = /^###[ \t]+T\d+\b/;

/** A top-level `- Field:` line, which is what ends a multi-line field. */
const TOP_FIELD = /^-[ \t]*[A-Za-z][\w ()-]*?[ \t]*:/;

/**
 * `- Field: value` at the top level of a list.
 *
 * The whitespace after the colon is spaces and tabs, never `\s`: `\s` matches a
 * newline, so an empty field would capture the line below it and a plan with
 * `- Owns:` left blank would report the next field as its ownership.
 */
const FIELD = /^[ \t]*-[ \t]*([A-Za-z][\w ()-]*?)[ \t]*:[ \t]*(.*)$/;

/** A `Done when` that is an actual command: something inside backticks. */
const BACKTICKED = /`([^`]+)`/;

/** What section 4 refuses to let past approval. */
export const NEEDS_DECISION = '[NEEDS DECISION]';

/**
 * Split a markdown document into sections keyed by heading text.
 *
 * @param {string} text
 * @returns {Map<string, string>} heading (without #) -> body
 */
function sections(text) {
  const found = new Map();
  let heading = '';
  let body = [];

  for (const line of String(text ?? '').split('\n')) {
    const match = /^(#{1,3})\s+(.*)$/.exec(line);
    if (match) {
      if (heading || body.length) found.set(heading, body.join('\n'));
      heading = match[2].trim();
      body = [];
      continue;
    }
    body.push(line);
  }
  found.set(heading, body.join('\n'));

  return found;
}

/**
 * Strip HTML comments. The guidance in a template is written for whoever fills
 * it in, and a parser that read it back would find every rule the comment
 * describes stated as though it had been followed.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Whether a field says "nothing" rather than listing anything.
 *
 * `(none — verification only, writes no files)` is how a plan writes the
 * ownership of a task that checks rather than writes, and it is a sentence.
 * listOf split it on its comma into `(none — verification only` and
 * `writes no files)`, and `pdkit task sync` stored those two phrases as the
 * files T8 owns — after which nothing downstream could tell them from paths.
 * The empty-ownership rule in checkPlan saw a list of two and passed; `slice
 * set` counted the requirements of the tasks owning each changed file, matched
 * neither phrase against anything, and refused the whole graph because R7, R8
 * and R15 reached no slice — requirements nobody had forgotten (18835).
 *
 * So: prose is not a path, and half a sentence is worse than no answer. An
 * empty list is a claim the rest of the plugin can act on, and it does.
 *
 * @param {string} value
 * @returns {boolean}
 */
function saysNothing(value) {
  const text = String(value ?? '').trim();

  // `(none`, whatever follows it, and the bare word alone. Deliberately not a
  // leading bare `none` with anything after it: `none.spec.ts` is a filename.
  return text === '' || /^[-*\s]*\(\s*none\b/i.test(text) || /^[-*\s]*none\s*\.?\s*$/i.test(text);
}

/**
 * Split a comma or newline separated list, dropping empties and the em dash
 * that templates use for "none".
 *
 * @param {string} value
 * @returns {string[]}
 */
function listOf(value) {
  if (saysNothing(value)) return [];

  return String(value ?? '')
    .split(/[,\n]/)
    .map((entry) => entry.replace(/^\s*[-*]\s*/, '').trim())
    // A code span is markdown decoration exactly like the bullet stripped above,
    // and stripping one while keeping the other is the whole defect. Measured on
    // 18832: a plan wrote its `Owns` section as ``- `path` `` bullets, `task sync`
    // stored the backticks verbatim, and the pre-write hook then refused a write
    // to a file it listed as owned two lines further down its own refusal — for
    // every task and every file, so the plan could not be executed at all.
    //
    // An entry carrying a decoration matches nothing, and nothing ever reports
    // that: the ownership hook has no way to tell a path it should not match from
    // a path it cannot match. That is why this is normalised at the parser rather
    // than asked of whoever writes the task file.
    .map((entry) => entry.replace(/^`(.*)`$/, '$1').trim())
    .filter((entry) => entry !== '' && entry !== '—' && entry !== '-');
}

/**
 * One task as the plan states it, parsed back out of plan.md.
 *
 * `owns` is the field with teeth: the pre-write hook reads it, and two tasks
 * claiming one file is refused, so the plan decides who may write what before
 * any worker starts. `doneWhen` keeps the original wording alongside the
 * extracted `command` because a refusal that quotes the plan is arguable with;
 * one that paraphrases it is not.
 *
 * `replaces` is read from the heading's `(replaces T2 and T3)` or from a
 * `- Replaces:` field, and `replacedBy` is its other end, filled in by
 * parsePlan when a later task in the same plan takes this one over. A replaced
 * task stays in the plan and keeps its ID — the reason R-IDs are never
 * renumbered holds for T-IDs as well — but it is not checked as live work.
 *
 * @typedef {object} PlanTask
 * @property {string} id
 * @property {string} title
 * @property {string[]} satisfies
 * @property {string[]} owns
 * @property {string|null} command   null when `Done when` is not a command
 * @property {string} doneWhen       as written, so a refusal can quote it
 * @property {string} steps          the `- Steps:` field with its indented lines, dedented
 * @property {string[]} replaces     the tasks this one takes over from
 * @property {string|null} [replacedBy]
 * @property {string} block          the task as written, heading included
 */

/**
 * A plan read back from disk, in the shape `plan check` and the auditor need.
 *
 * Parsed rather than kept as a structure, because plan.md is the artefact a
 * human reads and edits — a JSON twin would drift from it and one of the two
 * would be wrong without saying so. `needsDecision` is surfaced separately
 * because an unanswered `[NEEDS DECISION]` blocks approval: an unasked question
 * does not disappear, it becomes an assumption nobody agreed to.
 *
 * @typedef {object} Plan
 * @property {number|null} issue
 * @property {string[]} requirements
 * @property {string} e2eCoverage
 * @property {PlanTask[]} tasks
 * @property {string} sliceHypothesis
 * @property {string} openDecisions
 * @property {boolean} needsDecision
 */

/**
 * Parse a rendered plan.
 *
 * @param {string} text
 * @returns {Plan}
 */
export function parsePlan(text) {
  const clean = withoutComments(text);
  const bySection = sections(clean);

  // Read from the whole document rather than from a "header" section: the
  // first line of a plan is itself a heading, so the fields under it belong to
  // that heading's body and there is no unnamed section to look in. These
  // field names appear nowhere else in the shape.
  const issue = /PLAN:\s*DESKTOP-(\d+)/.exec(clean);
  const requirements = /^-[ \t]*Requirements:[ \t]*(.*)$/m.exec(clean);
  const e2e = /^-[ \t]*e2e coverage:[ \t]*(.*)$/im.exec(clean);

  const tasks = tasksIn(bySection);
  for (const task of tasks) {
    task.replacedBy = tasks.find((other) => other !== task && other.replaces.includes(task.id))?.id ?? null;
  }

  return {
    tasks,
    issue: issue ? Number.parseInt(issue[1], 10) : null,
    requirements: requirements ? listOf(requirements[1].replace(/\(.*\)/, '')) : [],
    e2eCoverage: e2e ? e2e[1].trim() : '',
    sliceHypothesis: (bySection.get('Slice hypothesis') ?? '').trim(),
    openDecisions: (bySection.get('Open decisions') ?? '').trim(),
    needsDecision: clean.includes(NEEDS_DECISION),
  };
}

/**
 * Collect the tasks out of a split plan.
 *
 * Each `### T<n>:` is its own section by the time the document has been split,
 * which is why tasks are read from the section map rather than by scanning the
 * body of `## Tasks` — that body ends at the first task heading.
 *
 * @param {Map<string, string>} bySection
 * @returns {PlanTask[]}
 */
function tasksIn(bySection) {
  const tasks = [];

  for (const [heading, body] of bySection) {
    const match = PLAN_TASK.exec(`### ${heading}`);
    if (!match) continue;

    const task = {
      id: match[1],
      title: match[3].trim(),
      satisfies: [],
      owns: [],
      command: null,
      doneWhen: '',
      steps: '',
      replaces: replacedIn(match[2] ?? ''),
      block: `### ${heading}\n${body}`.replace(/\s+$/, ''),
    };

    /** @type {string[]|null} lines of `- Steps:` while it is being read */
    let steps = null;
    for (const line of body.split('\n')) {
      if (steps !== null && !TOP_FIELD.test(line)) {
        steps.push(line);
        continue;
      }
      if (steps !== null) {
        task.steps = dedent(steps);
        steps = null;
      }

      const field = FIELD.exec(line);
      if (!field) continue;

      const name = field[1].toLowerCase();
      if (name === 'satisfies') task.satisfies = listOf(field[2]);
      else if (name === 'owns') task.owns = listOf(field[2]);
      else if (name === 'replaces') task.replaces = [...new Set([...task.replaces, ...replacedIn(`replaces ${field[2]}`)])];
      else if (name === 'steps') steps = field[2].trim() ? [field[2].trim()] : [];
      else if (name === 'done when') {
        task.doneWhen = field[2].trim();
        const command = BACKTICKED.exec(field[2]);
        task.command = command ? command[1].trim() : null;
      }
    }
    if (steps !== null) task.steps = dedent(steps);
    tasks.push(task);
  }

  return tasks;
}

/**
 * The task IDs a `(replaces …)` parenthesis names.
 *
 * Every T-ID in it, so `replaces T2 and T3`, `replaces T2, T3` and A1's
 * `replaces T4's gate` all say what they mean. A parenthesis that does not start
 * with `replaces` is a remark, and a T-ID in a remark withdraws nothing.
 *
 * @param {string} text
 * @returns {string[]}
 */
function replacedIn(text) {
  if (!/^\s*replaces\b/i.test(text)) return [];
  return [...new Set(text.match(/\bT\d+\b/g) ?? [])];
}

/**
 * Lines with their common indentation taken off, trailing blank lines dropped.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function dedent(lines) {
  const kept = [...lines];
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const indent = Math.min(...kept.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)[0].length));
  return kept.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/**
 * One task file, parsed — what the implementer is handed and what it owes back.
 *
 * The same task the plan declares, read from tasks/T<k>.md rather than from the
 * plan, because that file is what `task sync` writes the ownership map from and
 * what a worker re-reads before starting.
 *
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {number|null} issue
 * @property {string[]} satisfies
 * @property {string[]} owns
 * @property {string|null} command
 * @property {string} expected
 * @property {string} status
 * @property {Withdrawal|null} withdrawn  null for a live task
 */

/**
 * Why a task is no longer part of the plan.
 *
 * Withdrawn, never deleted and never renumbered: a receipt, a journal line or a
 * PR body that names T2 has to keep finding T2, and finding it marked is how a
 * reader learns the plan moved. `amendment` is null only for a status written
 * by hand without one, which is still a withdrawal and still refused work.
 *
 * @typedef {object} Withdrawal
 * @property {string|null} amendment
 * @property {string[]} replacedBy
 */

/**
 * Parse a task file (templates/task.md).
 *
 * The `Owns` set read here is the one `pdkit task sync` puts into state.json
 * for the pre-write hook, which makes this the authority on what a task may
 * write. That is deliberate: the task file comes from the plan, so the hook
 * guards what was agreed rather than what somebody typed into a command.
 *
 * @param {string} text
 * @returns {Task}
 */
export function parseTask(text) {
  const clean = withoutComments(text);
  const bySection = sections(clean);

  const title = /^#[ \t]+(T\d+)[ \t]*:[ \t]*(.*)$/m.exec(clean);
  const issue = /^-[ \t]*Issue:[ \t]*(\d+)/m.exec(clean);
  const satisfies = /^-[ \t]*Satisfies:[ \t]*(.*)$/m.exec(clean);
  const status = /^-[ \t]*Status:[ \t]*(.*)$/m.exec(clean);

  const doneWhen = bySection.get('Done when') ?? '';
  const command = /```(?:bash|sh)?\n([\s\S]*?)\n```/.exec(doneWhen);
  const expected = /^Expected:[ \t]*(.*)$/m.exec(doneWhen);

  return {
    id: title ? title[1] : '',
    title: title ? title[2].trim() : '',
    issue: issue ? Number.parseInt(issue[1], 10) : null,
    satisfies: satisfies ? listOf(satisfies[1]) : [],
    owns: listOf(bySection.get('Owns') ?? ''),
    command: command ? command[1].trim() : null,
    expected: expected ? expected[1].trim() : '',
    status: status ? status[1].trim() : '',
    withdrawn: withdrawalOf(status ? status[1] : ''),
  };
}

/** `withdrawn by A1 (replaced by T5)`, as a task file's Status says it. */
const WITHDRAWN = /^\s*withdrawn\b/i;

/**
 * Read a task's Status line as a withdrawal, or null when it is not one.
 *
 * @param {string} status
 * @returns {Withdrawal|null}
 */
export function withdrawalOf(status) {
  const text = String(status ?? '');
  if (!WITHDRAWN.test(text)) return null;

  const amendment = /\bby[ \t]+(A\d+)\b/i.exec(text);
  const replaced = /replaced[ \t]+by[ \t]+([^)]*)/i.exec(text);
  return {
    amendment: amendment ? amendment[1].toUpperCase() : null,
    replacedBy: replaced ? [...new Set(replaced[1].match(/\bT\d+\b/g) ?? [])] : [],
  };
}

/**
 * The Status a withdrawn task file carries. The other half of withdrawalOf.
 *
 * @param {Withdrawal} withdrawal
 * @returns {string}
 */
export function withdrawnStatus(withdrawal) {
  const by = withdrawal.amendment ? ` by ${withdrawal.amendment}` : '';
  const replaced = withdrawal.replacedBy.length > 0 ? ` (replaced by ${withdrawal.replacedBy.join(', ')})` : '';
  return `withdrawn${by}${replaced}`;
}

/** `- Status: pending` in a task file. */
const TASK_STATUS = /^([ \t]*-[ \t]*Status:[ \t]*)(.*)$/m;

/**
 * Rewrite the Status line of a task file, keeping everything else byte for byte.
 *
 * The same targeted replacement as setAmendmentStatus, for the same reason: what
 * was written into the task after it was rendered is the record. Null when there
 * is no Status line, so the caller says so rather than reporting it written.
 *
 * @param {string} text
 * @param {string} status
 * @returns {string|null}
 */
export function setTaskStatus(text, status) {
  if (!TASK_STATUS.test(text)) return null;
  return text.replace(TASK_STATUS, (_match, prefix) => `${prefix}${status}`);
}

/**
 * One reason an artefact was refused, named by the check that refused it.
 *
 * `check` rather than a severity, because these are not ranked: every problem
 * here is disqualifying, and the caller prints them together so one round trip
 * shows all of them instead of revealing them one at a time.
 *
 * @typedef {object} Problem
 * @property {string} check
 * @property {string} detail
 */

/**
 * The mechanical review of a plan.
 *
 * Everything here is a property of the parsed shape, and everything here is
 * blocking except where noted: these are the failures section 4 says get a plan
 * redone rather than patched.
 *
 * A task another task replaces, or one the record holds as withdrawn, is left
 * out of every check: it keeps its ID and its place in the plan, and it is not
 * work anybody is going to do. Checking it would report the requirements an
 * amendment withdrew as cited by the tasks it withdrew with them.
 *
 * @param {{plan: Plan, content?: string, record?: {requirements?: {ids: string[], frozen: boolean}, withdrawn?: Record<string, unknown>}}} input
 * @returns {Promise<{ok: boolean, problems: Problem[], warnings: Problem[]}>}
 */
export async function checkPlan(input) {
  const plan = input.plan;
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Problem[]} */
  const warnings = [];

  if (input.content !== undefined) {
    const structure = await validateSections('plan', input.content);
    for (const missing of structure.missing) {
      problems.push({ check: 'sections', detail: `the plan has no "${missing}" section` });
    }
  }

  // The requirement set the plan declares, cross-checked against the one the
  // issue has **allocated** — not against the frozen set, and the difference is
  // the point. Freezing happens at plan approval, so a check that waited for it
  // would be inert during the only phase that writes a plan. Reading the
  // allocated ids instead means a plan that invents an R-ID is caught before
  // anybody approves it: on 18832 a replan introduced R9 for work moved into
  // scope, and this is what would have refused it had the id never been
  // allocated through `pdkit ids requirement`.
  const declared = plan.requirements;
  const allocated = input.record?.requirements?.ids ?? null;

  if (allocated && allocated.length > 0) {
    for (const id of declared) {
      if (!allocated.includes(id)) problems.push({ check: 'requirements', detail: `the plan cites ${id}, which the issue does not have` });
    }
    for (const id of allocated) {
      if (!declared.includes(id)) problems.push({ check: 'requirements', detail: `${id} is allocated on the issue but the plan does not list it` });
    }
  }

  const withdrawn = input.record?.withdrawn ?? {};
  const live = plan.tasks.filter((task) => !task.replacedBy && !(task.id in withdrawn));

  if (live.length === 0) {
    problems.push({ check: 'tasks', detail: plan.tasks.length === 0 ? 'the plan has no tasks' : 'every task in the plan is withdrawn' });
  }

  const known = new Set(declared.length ? declared : (allocated ?? []));
  const covered = new Set();

  for (const task of live) {
    // A task that owns no files is a verification: a whole-suite gate, a
    // measurement, a run over a tree no other task touches. That is a shape a
    // plan is entitled to, and refusing it is what pushed two runs into writing
    // `(none — verification only, writes no files)` where paths go, which is
    // where the 18835 failure started. What makes it legitimate is `Done when`:
    // a task that writes nothing and runs nothing does nothing, and a task with
    // no ownership is not unconstrained — the pre-write hook refuses every file
    // for an empty Owns set, which is the whole of what a verification may do.
    if (task.owns.length === 0 && !task.command) {
      problems.push({
        check: 'owns',
        detail: `${task.id} owns no files and has no executable "Done when" — it writes nothing and checks nothing`,
      });
    }
    // Section 4, rule 4. A warning rather than a refusal: the threshold is
    // judgement, and a task touching four files is a conversation, not a defect.
    if (task.owns.length > 3) {
      warnings.push({ check: 'owns', detail: `${task.id} owns ${task.owns.length} files; the plan rule is one to three` });
    }

    if (!task.command) {
      problems.push({
        check: 'done-when',
        detail: `${task.id} has no executable "Done when"${task.doneWhen ? `: "${task.doneWhen}"` : ''} — prose cannot be checked by anyone except its author`,
      });
    }

    if (task.satisfies.length === 0) {
      problems.push({ check: 'satisfies', detail: `${task.id} satisfies no requirement` });
    }
    for (const id of task.satisfies) {
      covered.add(id);
      if (known.size > 0 && !known.has(id)) {
        problems.push({ check: 'satisfies', detail: `${task.id} satisfies ${id}, which the plan does not list` });
      }
    }
  }

  for (const id of known) {
    if (!covered.has(id)) problems.push({ check: 'coverage', detail: `${id} has no task` });
  }

  problems.push(...overlaps(live));

  if (plan.needsDecision) {
    problems.push({
      check: 'decisions',
      detail: `the plan still contains ${NEEDS_DECISION} — an unasked question does not disappear, it becomes an assumption nobody agreed to`,
    });
  }
  if (plan.e2eCoverage === '' || /^<.*>$/.test(plan.e2eCoverage)) {
    problems.push({ check: 'e2e', detail: 'e2e coverage is not decided; deciding afterwards produces a test for what was built rather than for what was required' });
  }
  if (plan.sliceHypothesis === '') {
    problems.push({ check: 'slice-hypothesis', detail: 'there is no slice hypothesis; planning without one produces a diff that cannot be cut without redoing the work' });
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Tasks whose ownership overlaps.
 *
 * Two patterns can overlap in ways nothing can decide in general, so this
 * checks what is decidable and says nothing about the rest: the same entry in
 * two tasks, and one task's literal path claimed by another task's pattern.
 * Those are the shapes real plans produce.
 *
 * @param {PlanTask[]} tasks
 * @returns {Problem[]}
 */
function overlaps(tasks) {
  /** @type {Problem[]} */
  const found = [];

  for (const [index, task] of tasks.entries()) {
    for (const other of tasks.slice(index + 1)) {
      for (const entry of task.owns) {
        for (const candidate of other.owns) {
          const collides =
            entry === candidate ||
            (!hasWildcard(entry) && safeMatch(entry, candidate)) ||
            (!hasWildcard(candidate) && safeMatch(candidate, entry));

          if (collides) {
            found.push({
              check: 'exclusive-owns',
              detail: `${task.id} and ${other.id} both claim ${entry === candidate ? entry : `${entry} / ${candidate}`} — exclusive ownership is what lets them run in parallel`,
            });
          }
        }
      }
    }
  }

  return found;
}

/**
 * Whether an Owns entry is a pattern rather than a single file.
 *
 * A trailing slash counts: `packages/main/src/` names a directory and everything
 * under it, which is a claim over many files even though it carries no `*`.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
function hasWildcard(pattern) {
  return /[*?]/.test(pattern) || pattern.endsWith('/');
}

/**
 * Match, treating a pattern this repository cannot express as "no overlap".
 * A malformed pattern is reported by the Owns check on its own task; making it
 * fail the whole review here would report one mistake twice.
 *
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
function safeMatch(path, pattern) {
  try {
    return matches(path, pattern);
  } catch {
    return false;
  }
}

/** The three things an amendment can be, and no fourth. */
export const AMENDMENT_STATUSES = ['proposed', 'approved', 'rejected'];

/** `- Status: proposed`, with whatever comment the template put after it. */
const AMENDMENT_STATUS = /^([ \t]*-[ \t]*Status:[ \t]*)([A-Za-z]+)([ \t]*.*)$/m;

/**
 * A change to an approved plan, and where it stands.
 *
 * Approval is the whole point of the record. A plan that quietly changed under
 * running work is a plan the audit cannot measure the diff against, so an
 * amendment is `proposed` until somebody says otherwise and the work continues
 * against the old plan until they do.
 *
 * @typedef {object} Amendment
 * @property {string} id
 * @property {number|null} issue
 * @property {string} source   what raised it: a review thread, upstream drift, a validation finding
 * @property {string} date
 * @property {'proposed'|'approved'|'rejected'|string} status
 * @property {RequirementChange[]} requirements   the rows of `## Requirements affected`, in file order
 * @property {PlanTask[]} tasks   the `### T<k>:` blocks of `## Slices affected`, read as a plan's are
 * @property {string[]} unreadTasks   headings there that start like a task and are not in the shape
 */

/**
 * One row of an amendment's `## Requirements affected` table.
 *
 * `change` is the canonical word, or null when the cell says something outside
 * the vocabulary — and null is reported rather than guessed at. The table is
 * what `amendment approve` applies to a frozen requirement set, which is the one
 * write the freeze lets through, so a row read as "withdrawn" because the cell
 * said "dropped (mostly)" would remove a requirement nobody agreed to remove.
 * `wrote` and `line` are there so the refusal can quote the row and say where it
 * is.
 *
 * @typedef {object} RequirementChange
 * @property {string[]} ids
 * @property {'added'|'withdrawn'|'unchanged'|'superseded'|'replaced'|null} change
 * @property {string|null} by       the R-ID a superseded or replaced requirement gives way to
 * @property {string} detail
 * @property {string} wrote         the Change cell as written
 * @property {number} line          1-based, in the amendment file
 * @property {string|null} problem  why the row was not understood; null when it was
 */

/** The Change words an amendment may use, and no others. */
export const REQUIREMENT_CHANGES = ['added', 'withdrawn', 'unchanged', 'superseded by R<k>', 'replaced by R<k>'];

/** An R-ID on its own, with the code span a person might put around it. */
const R_ID = /^`?(R\d+)`?$/;

/**
 * Split a markdown table row into its cells.
 *
 * A `\|` inside a cell is a literal pipe, which is how requirementRows writes
 * one, and splitting on it would push the end of a detail into a fourth column.
 *
 * @param {string} line
 * @returns {string[]}
 */
function cellsOf(line) {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());

  // The closing pipe leaves one empty cell behind it. Only that one: an empty
  // cell in the middle is a cell somebody left empty.
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Read a Change cell into its canonical word.
 *
 * @param {string} cell
 * @returns {{change: RequirementChange['change'], by: string|null}}
 */
function changeOf(cell) {
  const text = cell.replace(/`/g, '').replace(/\.$/, '').trim().toLowerCase();

  if (text === 'added' || text === 'withdrawn' || text === 'unchanged') return { change: text, by: null };

  const giving = /^(superseded|replaced)[ \t]+by[ \t]+(r\d+)$/.exec(text);
  if (giving) return { change: giving[1], by: giving[2].toUpperCase() };

  return { change: null, by: null };
}

/**
 * The rows of `## Requirements affected`.
 *
 * Read line by line rather than through sections(), because the refusal for a
 * row it cannot read names the line, and sections() has already thrown the line
 * numbers away. Comments are blanked rather than removed for the same reason —
 * removing one would move every row under it.
 *
 * @param {string} text
 * @returns {RequirementChange[]}
 */
function requirementChanges(text) {
  const lines = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''))
    .split('\n');

  const rows = [];
  let inside = false;

  for (const [index, line] of lines.entries()) {
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading) {
      inside = heading[1].trim().toLowerCase() === 'requirements affected';
      continue;
    }
    if (!inside || !line.trim().startsWith('|')) continue;

    const cells = cellsOf(line);
    // The header and the rule under it: neither is a change.
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (/^r-?id$/i.test(cells[0] ?? '')) continue;

    const row = {
      ids: [],
      change: null,
      by: null,
      // Whatever is past the third column belongs to the detail. A detail with
      // an unescaped pipe in it is still the detail, and dropping the end of it
      // would lose the half of the sentence after the pipe.
      detail: cells.slice(2).filter(Boolean).join(' | '),
      wrote: cells[1] ?? '',
      line: index + 1,
      problem: null,
    };

    const named = (cells[0] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    const unreadable = named.filter((entry) => !R_ID.test(entry));
    row.ids = named.filter((entry) => R_ID.test(entry)).map((entry) => R_ID.exec(entry)[1]);

    Object.assign(row, changeOf(row.wrote));

    if (named.length === 0) row.problem = 'the R-ID cell is empty';
    else if (unreadable.length > 0) row.problem = `${unreadable.map((entry) => `"${entry}"`).join(', ')} is not an R-ID`;
    else if (row.change === null) {
      row.problem = `"${row.wrote}" is not a change this table can say (${REQUIREMENT_CHANGES.join(' | ')})`;
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Write the rows of `## Requirements affected`, for the template.
 *
 * The other half of requirementChanges, and here for the reason the header of
 * this module gives: a template that renders one row while the parser reads
 * many is how the table came to be completed by hand on 18915, after which the
 * parser was reading somebody's markup rather than the template's.
 *
 * Accepts `rid` as an array or a comma-separated string. A pipe in a cell is
 * escaped and a newline flattened: either would end the row early.
 *
 * @param {Array<{rid: string|string[], change: string, detail?: string}>} rows
 * @returns {string}
 */
export function requirementRows(rows) {
  const cell = (value) => String(value ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();

  return rows
    .map((row) => {
      const ids = Array.isArray(row.rid) ? row.rid.join(', ') : row.rid;
      return `| ${cell(ids)} | ${cell(row.change)} | ${cell(row.detail)} |`;
    })
    .join('\n');
}

/**
 * Parse an amendment file (templates/plan-amendment.md).
 *
 * The status is read from the file rather than from the journal because the
 * file is the artefact a person opens. An amendment still saying `proposed`
 * after somebody approved it is not a stale cache — it is the record of the
 * decision, contradicting the decision.
 *
 * @param {string} text
 * @returns {Amendment}
 */
export function parseAmendment(text) {
  const clean = withoutComments(text);

  const title = /^#[ \t]+AMENDMENT[ \t]+(A\d+)[ \t]*:[ \t]*DESKTOP-(\d+)/m.exec(clean);
  const source = /^-[ \t]*Raised by:[ \t]*(.*)$/m.exec(clean);
  const date = /^-[ \t]*Date:[ \t]*(.*)$/m.exec(clean);
  const status = AMENDMENT_STATUS.exec(clean);

  return {
    id: title ? title[1] : '',
    issue: title ? Number.parseInt(title[2], 10) : null,
    source: source ? source[1].trim() : '',
    date: date ? date[1].trim() : '',
    status: status ? status[2].trim().toLowerCase() : '',
    requirements: requirementChanges(text),
    ...amendmentTasks(clean),
  };
}

/**
 * The tasks an amendment writes, out of `## Slices affected`.
 *
 * Read by tasksIn, the reader plan.md goes through, and from nowhere but that
 * section. A1 on 18915 wrote T5 and T6 in exactly a plan's shape, and they
 * stayed text: the task files were typed by hand in the execution session and
 * the ownership map never heard of them. A second reader here would be a second
 * opinion on what a task is; the one the plan is held to is the one that counts.
 *
 * A heading that starts like a task and does not parse is returned, not
 * skipped. Skipping it would approve an amendment whose task nobody will
 * materialise, which is the defect this exists to close.
 *
 * @param {string} clean   the amendment with comments removed
 * @returns {{tasks: PlanTask[], unreadTasks: string[]}}
 */
function amendmentTasks(clean) {
  const lines = clean.split('\n');
  const start = lines.findIndex((line) => /^##[ \t]+slices affected[ \t]*$/i.test(line));
  if (start === -1) return { tasks: [], unreadTasks: [] };

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}[ \t]/.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n');

  return {
    tasks: tasksIn(sections(section)),
    unreadTasks: section
      .split('\n')
      .filter((line) => TASK_LIKE.test(line) && !PLAN_TASK.test(line))
      .map((line) => line.trim()),
  };
}

/**
 * Why the tasks of an amendment cannot be made into task files, if anything.
 *
 * The plan's own per-task rules — a `Done when` that runs, a requirement
 * satisfied, files or a command — and the ones only an amendment can break:
 * withdrawing a task the plan does not have, reusing the ID of a task that is
 * something else, and claiming a file a task still live after the amendment
 * already owns. Asked before approval, like the requirement table, so an
 * amendment whose tasks cannot be written stays proposed.
 *
 * @param {{amendment: Amendment, plan?: Plan|null, requirements?: string[]}} input
 *   `requirements` is the live set as it will be once the amendment applies
 * @returns {string[]}
 */
export function amendmentTaskProblems(input) {
  const { amendment } = input;
  const planned = input.plan?.tasks ?? [];
  const live = new Set(input.requirements ?? []);
  const problems = amendment.unreadTasks.map(
    (heading) => `"${heading}" in "Slices affected" is not a task heading the plan parser reads (### T<k>: title, or ### T<k> (replaces T<j>): title)`,
  );

  const titled = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  const replaced = new Set(amendment.tasks.flatMap((task) => task.replaces));

  for (const task of amendment.tasks) {
    if (!task.command) problems.push(`${task.id} has no executable "Done when"${task.doneWhen ? `: "${task.doneWhen}"` : ''}`);
    if (task.satisfies.length === 0) problems.push(`${task.id} satisfies no requirement`);
    for (const id of task.satisfies) {
      if (live.size > 0 && !live.has(id)) problems.push(`${task.id} satisfies ${id}, which is not in the requirement set once ${amendment.id} applies`);
    }
    if (task.replaces.includes(task.id)) problems.push(`${task.id} says it replaces itself`);

    const same = planned.find((other) => other.id === task.id);
    if (same && titled(same.title) !== titled(task.title)) {
      problems.push(`${task.id} is already a task in the plan ("${same.title}") — a new task takes the next free ID, an existing one is never reused`);
    }
  }

  if (input.plan) {
    for (const id of replaced) {
      if (!planned.some((task) => task.id === id)) problems.push(`${id} is withdrawn by ${amendment.id}, and the plan has no ${id}`);
    }
  }

  const ours = new Set(amendment.tasks.map((task) => task.id));
  const stays = planned.filter((task) => !ours.has(task.id) && !replaced.has(task.id) && !task.replacedBy);
  problems.push(...overlaps([...stays, ...amendment.tasks]).map((problem) => problem.detail));

  return problems;
}

/**
 * The values templates/task.md is rendered from, for a task an amendment wrote.
 *
 * Nothing invented: every field is the amendment's, and the parts it does not
 * state — the attempt count, the notes — are what `/pd:plan` would start a task
 * with. `Expected` is whatever `Done when` says after its command, because that
 * is where both A1 and the plan template put it.
 *
 * @param {PlanTask} task
 * @param {{issue: number, amendment: string}} context
 * @returns {Record<string, string|string[]>}
 */
export function amendmentTaskValues(task, context) {
  const after = task.doneWhen.slice(task.doneWhen.indexOf('`', task.doneWhen.indexOf('`') + 1) + 1);
  const expected = after.replace(/^[\s\->→—:]+/, '').trim();
  const replaces = task.replaces.length > 0 ? `; replaces ${task.replaces.join(', ')}` : '';

  return {
    taskId: task.id,
    title: task.title,
    issue: String(context.issue),
    satisfies: task.satisfies.join(', '),
    status: 'pending',
    attempts: '0',
    ownedFiles: task.owns.length > 0 ? task.owns.map((entry) => `- ${entry}`) : ['- (none — verification only, writes no files)'],
    command: task.command ?? '',
    expected: expected || 'exit 0',
    context: `From ${context.amendment} (amendments/${context.amendment}.md${replaces}). See plan.md Context; frozen interfaces in plan.md are binding.`,
    steps: task.steps || '—',
    notes: `Rendered from ${context.amendment}'s "Slices affected" when it was approved.`,
  };
}

/**
 * Add the tasks an amendment wrote to plan.md's `## Tasks`, those it lacks.
 *
 * Each block goes in as the amendment wrote it, heading and `(replaces …)`
 * included, which is what lets parsePlan mark the tasks it replaces. A task the
 * plan already has is left as it is: on 18915 T5 and T6 were copied in by hand,
 * and a second copy would be two tasks with one ID.
 *
 * Returns null when the plan has no `## Tasks` section to add to.
 *
 * @param {string} text
 * @param {PlanTask[]} tasks
 * @returns {{text: string, added: string[]}|null}
 */
export function addPlanTasks(text, tasks) {
  const have = new Set(parsePlan(text).tasks.map((task) => task.id));
  const missing = tasks.filter((task) => !have.has(task.id));
  if (missing.length === 0) return { text, added: [] };

  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##[ \t]+Tasks[ \t]*$/.test(line));
  if (start === -1) return null;

  let end = lines.findIndex((line, index) => index > start && /^#{1,2}[ \t]/.test(line));
  if (end === -1) end = lines.length;
  // Before the blank lines that close the section, so the next heading keeps its gap.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;

  const blocks = missing.map((task) => `\n${task.block}`);
  lines.splice(end, 0, ...blocks);
  return { text: lines.join('\n'), added: missing.map((task) => task.id) };
}

/**
 * Rewrite the status line of an amendment, keeping everything else byte for byte.
 *
 * A targeted replacement rather than a re-render, and the difference matters:
 * re-rendering from the template would need every value the file was written
 * with, and the parts a person wrote by hand afterwards — the reasoning, the
 * quoted reviewer, the correction A1 carries at its top — are exactly the parts
 * that are not in any values file. Those are the record. The status is one word.
 *
 * Returns null when there is no status line to rewrite, so the caller can say
 * that rather than silently appending one and reporting success.
 *
 * @param {string} text
 * @param {'proposed'|'approved'|'rejected'} status
 * @returns {string|null}
 */
export function setAmendmentStatus(text, status) {
  if (!AMENDMENT_STATUSES.includes(status)) return null;
  if (!AMENDMENT_STATUS.test(text)) return null;

  return text.replace(AMENDMENT_STATUS, (_match, prefix, _was, rest) => `${prefix}${status}${rest}`);
}

/** `- Requirements: R1, R2 (frozen on approval)` in a plan. */
const PLAN_REQUIREMENTS = /^([ \t]*-[ \t]*Requirements:[ \t]*)(.*)$/m;

/**
 * Rewrite the requirement line of a plan to the set the issue now has.
 *
 * The same targeted replacement as setAmendmentStatus, for the same reason: the
 * plan is edited by hand after it is rendered, and the rest of it is the record.
 * The amendments are named on the line itself so that a plan read on its own
 * says why its set is not the one it was approved with — parsePlan drops the
 * parenthesis, so naming them there costs the parse nothing.
 *
 * Returns null when there is no such line, so the caller can say the plan was
 * left behind rather than report it updated.
 *
 * @param {string} text
 * @param {string[]} ids
 * @param {string[]} amendments
 * @returns {string|null}
 */
export function setPlanRequirements(text, ids, amendments) {
  if (!PLAN_REQUIREMENTS.test(text)) return null;

  // `(frozen on approval)` stays as the template wrote it: validateSections
  // holds every plan to that text, and folding the amendments into the same
  // parenthesis reported the plan as missing a section.
  const note = amendments.length > 0 ? ` (amended by ${amendments.join(', ')})` : '';
  return text.replace(PLAN_REQUIREMENTS, (_match, prefix) => `${prefix}${ids.join(', ') || '—'} (frozen on approval)${note}`);
}

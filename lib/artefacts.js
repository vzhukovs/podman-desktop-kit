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

/** `### T1: title` inside a plan. */
const PLAN_TASK = /^###[ \t]+(T\d+)[ \t]*:[ \t]*(.*)$/;

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
 * Split a comma or newline separated list, dropping empties and the em dash
 * that templates use for "none".
 *
 * @param {string} value
 * @returns {string[]}
 */
function listOf(value) {
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
 * @typedef {object} PlanTask
 * @property {string} id
 * @property {string} title
 * @property {string[]} satisfies
 * @property {string[]} owns
 * @property {string|null} command   null when `Done when` is not a command
 * @property {string} doneWhen       as written, so a refusal can quote it
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

  return {
    tasks: tasksIn(bySection),
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

    const task = { id: match[1], title: match[2].trim(), satisfies: [], owns: [], command: null, doneWhen: '' };
    for (const line of body.split('\n')) {
      const field = FIELD.exec(line);
      if (!field) continue;

      const name = field[1].toLowerCase();
      if (name === 'satisfies') task.satisfies = listOf(field[2]);
      else if (name === 'owns') task.owns = listOf(field[2]);
      else if (name === 'done when') {
        task.doneWhen = field[2].trim();
        const command = BACKTICKED.exec(field[2]);
        task.command = command ? command[1].trim() : null;
      }
    }
    tasks.push(task);
  }

  return tasks;
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
  };
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
 * @param {{plan: Plan, content?: string, record?: {requirements?: {ids: string[], frozen: boolean}}}} input
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

  if (plan.tasks.length === 0) {
    problems.push({ check: 'tasks', detail: 'the plan has no tasks' });
  }

  const known = new Set(declared.length ? declared : (allocated ?? []));
  const covered = new Set();

  for (const task of plan.tasks) {
    if (task.owns.length === 0) {
      problems.push({ check: 'owns', detail: `${task.id} owns no files, so nothing constrains what it may write` });
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

  problems.push(...overlaps(plan.tasks));

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
 */

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
  };
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

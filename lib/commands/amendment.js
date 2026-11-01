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

// `pdkit amendment`: allocate an A-ID and render an amendment; list, approve,
// reject or sync one.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  coverageProblemsOf,
  describeSynced,
  readAmendments,
  reconcileAmendment,
  taskProblemsOf,
} from '../amendment.js';
import { parseAmendment, requirementRows, setAmendmentStatus } from '../artefacts.js';
import { resolveHome } from '../config.js';
import * as ids from '../ids.js';
import * as journal from '../journal.js';
import * as render from '../render.js';
import * as state from '../state.js';
import { EXIT, ageOf, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'by', 'reason', 'values'];

export const ACTIONS = {
  approve: oneAmendment(decide),
  reject: oneAmendment(decide),
  sync: oneAmendment(sync),
  list,
  new: create,
};

/**
 * Print what reconcileAmendment did, and what it could not.
 *
 * @param {string} id
 * @param {number} issue
 * @param {Awaited<ReturnType<typeof reconcileAmendment>>} outcome
 */
function printReconciled(id, issue, outcome) {
  const list = (ids) => ids.join(', ') || 'none';
  const set = outcome.requirements;

  if (set) {
    if (set.already) process.stdout.write(`  requirements  ${list(set.after)} — ${id} was applied already\n`);
    else if (set.reflected) {
      process.stdout.write(`  requirements  ${list(set.after)} — the record already said this; ${id} is now recorded as what did it\n`);
    } else if (set.added.length + set.removed.length > 0) {
      process.stdout.write(`  requirements  was ${list(set.before)}\n`);
      process.stdout.write(`                now ${list(set.after)}\n`);
      if (set.added.length) process.stdout.write(`                added ${list(set.added)}\n`);
      if (set.removed.length) process.stdout.write(`                out of the live set ${list(set.removed)} (the IDs are kept, never renumbered)\n`);
    } else if (outcome.plan) process.stdout.write(`  requirements  ${list(set.after)}, unchanged\n`);
  }

  if (outcome.plan) {
    process.stdout.write(
      outcome.plan.written
        ? `  plan.md       "- Requirements:" was ${list(outcome.plan.before)}, now ${list(outcome.plan.after)}\n`
        : `  plan.md       already says ${list(outcome.plan.after)}\n`,
    );
  }

  const tasks = outcome.tasks;
  if (tasks) {
    const files = (ids) => ids.map((task) => `tasks/${task}.md`).join(', ');
    if (tasks.written.length) process.stdout.write(`  tasks         wrote ${files(tasks.written)}\n`);
    if (tasks.kept.length) process.stdout.write(`  tasks         ${files(tasks.kept)} already there, kept as written\n`);
    for (const entry of tasks.withdrawn) {
      process.stdout.write(
        `  withdrawn     ${entry.task}${entry.replacedBy.length ? ` (replaced by ${entry.replacedBy.join(', ')})` : ''}` +
          `${entry.released.length ? ` — no longer owns ${entry.released.join(', ')}` : ''}\n`,
      );
    }
    if (tasks.plan.length) process.stdout.write(`  plan.md       gained ${tasks.plan.join(', ')} under "## Tasks"\n`);
    if (tasks.synced) process.stdout.write(`  owns          ${tasks.synced.map(describeSynced).join('\n                ')}\n`);
  }

  if (outcome.unreconciled.length > 0) {
    process.stderr.write(`\n  ${id} is approved, and this did not follow it:\n`);
    for (const line of outcome.unreconciled) process.stderr.write(`    ✘ ${line}\n`);
    process.stderr.write(
      `  Until it does, the plan and the record disagree with the decision. Fix what is named above, then\n` +
        `  \`pdkit amendment sync ${id} --issue ${issue}\` — nothing already applied is applied again.\n`,
    );
  }
}

/**
 * The decisions — approve, reject, sync — are about one amendment of one
 * issue, and it is found before the action runs.
 *
 * @param {(context: object, flags: Record<string, string|boolean>) => Promise<number>} handler
 */
function oneAmendment(handler) {
  return async ({ action, args }, flags) => {
    const issue = issueFlag(flags);
    if (!Number.isInteger(issue)) {
      process.stderr.write(`pdkit amendment ${action}: --issue <n> is required\n`);
      return EXIT.ERROR;
    }

    const id = String(args[1] ?? '').trim().toUpperCase();
    if (!/^A\d+$/.test(id)) {
      process.stderr.write(`pdkit amendment ${action}: an amendment ID is required, such as A1\n`);
      return EXIT.ERROR;
    }

    // Required on reject and not on approve, and the asymmetry is the point: an
    // approved amendment is explained by the amendment itself, while a rejected
    // one leaves nothing behind except this sentence. Same rule as `task unblock`
    // and `issue adopt`.
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
    if (action === 'reject' && !reason) {
      process.stderr.write(
        'pdkit amendment reject: --reason <why> is required — a rejected amendment is the only record of why the plan did not move\n',
      );
      return EXIT.ERROR;
    }

    const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
    const amendments = await readAmendments(issue, home);
    const found = amendments.find((entry) => entry.id === id);

    if (!found) {
      process.stderr.write(
        `pdkit amendment ${action}: DESKTOP-${issue} has no ${id}` +
          (amendments.length > 0 ? ` — it has ${amendments.map((entry) => entry.id).join(', ')}\n` : ' — and no amendments at all\n'),
      );
      return EXIT.ERROR;
    }

    return handler({ action, issue, id, reason, home, found }, flags);
  };
}

async function sync({ issue, id, home, found }, flags) {
  if (found.status !== 'approved') {
    process.stderr.write(
      `pdkit amendment sync: ${id} is ${found.status || 'in no recognised status'}, not approved — only an approved amendment is applied\n`,
    );
    return EXIT.ERROR;
  }
  const outcome = await reconcileAmendment(issue, id, home);
  if (flags.json) printJson({ id, issue, status: found.status, ...outcome });
  else {
    process.stdout.write(`${id}  DESKTOP-${issue}  approved\n`);
    printReconciled(id, issue, outcome);
    const moved = outcome.tasks ? outcome.tasks.written.length + outcome.tasks.withdrawn.length + outcome.tasks.plan.length : 0;
    if (!outcome.requirements?.added.length && !outcome.requirements?.removed.length && !outcome.plan?.written && !moved && outcome.unreconciled.length === 0) {
      process.stdout.write('  nothing to bring into line\n');
    }
  }
  return outcome.unreconciled.length === 0 ? EXIT.OK : EXIT.ERROR;
}

/**
 * Approve or reject an amendment.
 *
 * The command `pdkit amendment new` has always ended by saying "nothing moves
 * until this is approved", and until now there was nothing that could approve
 * one. An instruction with no way to carry it out is worse than an absent one:
 * in review it reads as a discipline being kept, and on DESKTOP-18548 two
 * amendments sat `proposed` for six days with the work running against a plan
 * neither of them had changed.
 *
 * No state transition. An amendment does not move the issue — the plan becomes
 * what the amendment says and the work continues against it. What finds the work
 * done against the previous version is `pdkit audit`, which is its job.
 *
 * "The plan becomes what the amendment says" used to be true of one word in the
 * amendment's own header. On 18915 A1 was approved and the issue still held R1–R6
 * frozen, plan.md still listed them, and both were mended by hand. So approval
 * applies the requirement table now, and checks it applies before writing the
 * status: an amendment that says `approved` over a table the record cannot take
 * is a decision nobody can carry out. Tasks the amendment describes are not
 * written into the plan here; that is a separate step.
 *
 * Reject changes the status and nothing else.
 *
 * @param {{action: string, issue: number, id: string, reason: string, home: string, found: object}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function decide({ action, issue, id, reason, home, found }, flags) {
  const status = action === 'approve' ? 'approved' : 'rejected';
  if (found.status === status) {
    process.stderr.write(
      `pdkit amendment ${action}: ${id} is already ${status}` +
        (status === 'approved' ? ` — if its requirements or tasks did not reach the record, plan.md or tasks/, \`pdkit amendment sync ${id} --issue ${issue}\`\n` : '\n'),
    );
    return EXIT.ERROR;
  }
  if (found.status !== 'proposed') {
    process.stderr.write(
      `pdkit amendment ${action}: ${id} is ${found.status || 'in no recognised status'}, not proposed — ` +
        'a decision that has been taken is not retaken by a command\n',
    );
    return EXIT.ERROR;
  }

  // Asked before the status is written, so that a table the record cannot take
  // leaves the amendment proposed rather than approved and unapplicable.
  if (status === 'approved' && found.requirements.length > 0) {
    const record = await state.read(issue, { home });
    const problems =
      record.route === 'quickfix'
        ? [`DESKTOP-${issue} is on the quickfix route and has no R-IDs for the table to change`]
        : (record.requirements.amendments ?? []).includes(id)
          ? []
          : state.amendedRequirements(record.requirements, found.requirements).problems;

    if (problems.length > 0) {
      process.stderr.write(`pdkit amendment approve: ${id}'s "Requirements affected" cannot be applied, so it stays proposed:\n`);
      for (const problem of problems) process.stderr.write(`  ✘ ${problem}\n`);
      process.stderr.write(`  ${found.path}\n`);
      return EXIT.ERROR;
    }
  }

  // The tasks, for the same reason and at the same moment: an approved
  // amendment whose T5 cannot be written is the 18915 execution session again.
  if (status === 'approved') {
    const problems = await taskProblemsOf(issue, found, home);
    if (problems.length > 0) {
      process.stderr.write(`pdkit amendment approve: ${id}'s tasks in "Slices affected" cannot be written, so it stays proposed:\n`);
      for (const problem of problems) process.stderr.write(`  ✘ ${problem}\n`);
      process.stderr.write(`  ${found.path}\n`);
      return EXIT.ERROR;
    }
  }

  // And the requirements: one this amendment adds, or orphans, must have a
  // live task to satisfy it. Approving it anyway is how A3 on 18833 reached
  // slice set with R18 and R19 belonging to nothing.
  if (status === 'approved') {
    const uncovered = await coverageProblemsOf(issue, found, home);
    if (uncovered.length > 0) {
      process.stderr.write(
        `pdkit amendment approve: after ${id}, ${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} satisfied by no live task, so it stays proposed.\n` +
          '  Add a task under "Slices affected" that satisfies it. If no task can own its files without sharing them,\n' +
          '  this issue cannot hold that work: it belongs in an issue of its own, and this one waits for it (`pdkit issue block`).\n' +
          `  ${found.path}\n`,
      );
      return EXIT.ERROR;
    }
  }

  const rewritten = setAmendmentStatus(await readFile(found.path, 'utf8'), status);
  if (rewritten === null) {
    process.stderr.write(`pdkit amendment ${action}: ${found.path} has no "- Status:" line to update\n`);
    return EXIT.ERROR;
  }
  await writeFile(found.path, rewritten);

  const by = typeof flags.by === 'string' ? flags.by.trim() : '';
  await journal.append(
    {
      issue,
      event: `amendment-${status}`,
      detail: [id, by ? `by ${by}` : '', reason].filter(Boolean).join(' — '),
    },
    { home },
  );

  const outcome = status === 'approved' ? await reconcileAmendment(issue, id, home) : null;

  if (flags.json) printJson({ id, issue, status, path: found.path, ...(outcome ?? {}) });
  else {
    process.stdout.write(`${id}  DESKTOP-${issue}  ${status}\n`);
    if (reason) process.stdout.write(`  ${reason}\n`);
    process.stdout.write(`  ${found.path} updated\n`);
    if (outcome) printReconciled(id, issue, outcome);
    if (status === 'approved') {
      process.stdout.write('  The plan is now what this says it is. Work done against the previous version is drift, and `pdkit audit` is what finds it.\n');
    }
  }

  return outcome && outcome.unreconciled.length > 0 ? EXIT.ERROR : EXIT.OK;
}

/**
 * @param {number} issue
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runAmendmentList(issue, flags) {
  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const amendments = await readAmendments(issue, home);

  if (flags.json) {
    printJson(amendments.map(({ path, ...entry }) => ({ ...entry, path })));
    return EXIT.OK;
  }

  process.stdout.write(`DESKTOP-${issue}\n`);
  if (amendments.length === 0) {
    process.stdout.write('  no amendments\n');
    return EXIT.OK;
  }

  for (const entry of amendments) {
    process.stdout.write(`  ${entry.id}  ${(entry.status || '?').padEnd(9)} ${ageOf(entry.date).padStart(5)}   ${entry.source}\n`);
  }

  const waiting = amendments.filter((entry) => entry.status === 'proposed');
  if (waiting.length > 0) {
    process.stdout.write(
      `\n  ${waiting.length} awaiting approval. Nothing in the plan has moved: an amendment is a proposal\n` +
        '  until somebody says otherwise, and the work is still running against the plan as it was.\n',
    );
  }

  return EXIT.OK;
}

export async function run(args, flags) {
  const action = args[0] ?? '';

  if (!Object.hasOwn(ACTIONS, action)) {
    process.stderr.write(`pdkit amendment: unknown action "${action}" (new, list, approve, reject, sync)\n`);
    return EXIT.ERROR;
  }

  return ACTIONS[action]({ action, args }, flags);
}

async function list(context, flags) {
  const number = issueFlag(flags);
  if (!Number.isInteger(number)) {
    process.stderr.write('pdkit amendment list: --issue <n> is required\n');
    return EXIT.ERROR;
  }
  return await runAmendmentList(number, flags);
}

async function create(context, flags) {
  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit amendment new: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const given = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};

  // The requirement table, as rows. `rid`/`change`/`detail` at the top level is
  // the one-row shape the template had before, still accepted so a values file
  // written for it renders the same row. Checked here, before the counter
  // moves, with the parser `approve` will use: a Change word it cannot read is
  // cheaper to hear about now than at approval.
  const rows = Array.isArray(given.rows)
    ? given.rows
    : given.rows === undefined && 'rid' in given
      ? [{ rid: given.rid, change: given.change, detail: given.detail }]
      : null;
  const values = { ...given };
  if (rows) {
    values.rows = requirementRows(rows);
    const unread = parseAmendment(`## Requirements affected\n${values.rows}\n`).requirements.filter((row) => row.problem);
    if (unread.length > 0) {
      process.stderr.write(
        `pdkit amendment new: ${unread.map((row) => `row ${row.line - 1}: ${row.problem}`).join('; ')}\n` +
          '  Each row is {"rid": "R7" or ["R2", "R6"], "change": "added", "detail": "..."}. No A-ID has been spent.\n',
      );
      return EXIT.ERROR;
    }
  }

  // Asked before the counter moves. Allocating and then throwing on the render
  // spends an A-ID on an amendment that was never written, which is how
  // DESKTOP-18832 ended up with a ledger that starts at A2 — and a gap reads
  // like a rejected amendment somebody deleted rather than like a typo.
  const absent = await render.missing('planAmendment', { issue, index: 0, date: '', status: '', ...values });
  if (absent.length > 0) {
    process.stderr.write(
      `pdkit amendment new: no value for ${absent.join(', ')}\n` +
        '  They come from --values <file.json>, one key per name; see templates/plan-amendment.md for what each\n' +
        '  section is for. No A-ID has been spent.\n',
    );
    return EXIT.ERROR;
  }

  // The number comes from the counter, not from the caller: an amendment is
  // referred to from the plan, the slices and the reply that told a reviewer
  // what changed, and a second A1 makes all three ambiguous.
  const id = await ids.allocateAmendment(issue, { home });
  const index = id.slice(1);

  const path = await render.write({
    issue,
    template: 'planAmendment',
    path: join('amendments', `${id}.md`),
    home,
    values: { issue, index, date: new Date().toISOString().slice(0, 10), status: 'proposed', ...values },
  });

  await journal.append({ issue, event: 'amendment-proposed', detail: `${id} — awaiting approval` }, { home });

  if (flags.json) printJson({ id, path });
  else {
    process.stdout.write(`${path}\n`);
    process.stdout.write('  nothing moves until this is approved — an amendment applied quietly makes the plan a record of what happened\n');
  }

  return EXIT.OK;
}
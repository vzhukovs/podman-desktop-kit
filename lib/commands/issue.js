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

// `pdkit issue`: read or escalate an upstream issue.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { join } from 'node:path';

import * as archaeology from '../archaeology.js';
import * as backlog from '../backlog.js';
import * as blocks from '../blocks.js';
import { get, load, resolveHome } from '../config.js';
import * as gh from '../gh.js';
import * as ids from '../ids.js';
import * as pr from '../pr.js';
import * as render from '../render.js';
import * as state from '../state.js';
import { EXIT, printJson, repoContext, titleFrom } from './support.js';

export const flags = ['label', 'limit', 'reason', 'state', 'pr', 'branch', 'route', 'full', 'by', 'check', 'all', 'what', 'raised-by', 'url', 'prior', 'title'];

const ACTIONS = {
  // Before the number is required: this one is about the backlog, and asking
  // it to name an issue would be asking it to answer itself.
  list,
  fetch: withIssue(fetchIssue),
  history: withIssue(history),
  adopt: withIssue(adopt),
  rework: withIssue(rework),
  block: withIssue(blockOrUnblock),
  unblock: withIssue(blockOrUnblock),
  'draft-blocker': withIssue(draftBlocker),
  blocks: withIssue(listBlocks),
  escalate: withIssue(escalate),
};

/**
 * Which of an issue's comments `issue fetch` prints.
 *
 * Forty comments on a podman-desktop issue is ordinary, and this is the input to
 * the dearest phase of the cycle. The NEWEST are kept, not the oldest: a
 * discussion converges on its answer, so the latest comments are the ones
 * closest to what has to be done, and the early ones are usually the questions
 * those answer. Said here because the obvious cut is the other one.
 *
 * What is left out is counted and the caller says so, with the flag that prints
 * it. The body never comes through here: it is the requirement, and is printed
 * whole.
 *
 * @template T
 * @param {T[]} comments   oldest first, as GitHub returns them
 * @param {{limit?: unknown, full?: boolean}} options
 * @returns {{shown: T[], hidden: number}}
 */
export function commentsToShow(comments, options) {
  const limit = Number.parseInt(String(options.limit ?? 15), 10);
  // A limit that does not parse prints everything: failing open is the safe
  // direction for something somebody is about to read as the requirement.
  if (options.full || !Number.isInteger(limit) || limit < 0 || comments.length <= limit) {
    return { shown: comments, hidden: 0 };
  }
  return { shown: comments.slice(comments.length - limit), hidden: comments.length - limit };
}

/**
 * Read or escalate an upstream issue.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const [action, rawIssue] = args;

  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : withIssue(unknown);
  return handler({ action, rawIssue }, flags);
}

async function list(context, flags) {
  const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  const labels = typeof flags.label === 'string' ? flags.label.split(',').map((name) => name.trim()).filter(Boolean) : [];
  const report = await backlog.collect({
    labels,
    limit: typeof flags.limit === 'string' ? Number.parseInt(flags.limit, 10) : undefined,
    config,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(backlog.format(report));
  // Zero whatever comes back. An empty backlog is an answer, and an exit code
  // here would be a verdict on issues this command deliberately does not judge.
  return EXIT.OK;
}

/**
 * Every action but list is about one issue, and its number is required before
 * the action runs — an unknown action included.
 *
 * @param {(context: object, flags: Record<string, string|boolean>) => Promise<number>} handler
 */
function withIssue(handler) {
  return async (context, flags) => {
    const issue = Number.parseInt(context.rawIssue, 10);

    if (!Number.isInteger(issue)) {
      process.stderr.write('pdkit issue: an issue number is required\n');
      return EXIT.ERROR;
    }

    return handler({ ...context, issue }, flags);
  };
}

async function fetchIssue({ issue }, flags) {
  const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const [record, linked] = await Promise.all([
    gh.fetchIssue(issue, { config }),
    gh.linkedPullRequests(issue, { config }),
  ]);

  if (flags.json) {
    printJson({ issue: record, linkedPullRequests: linked });
    return EXIT.OK;
  }

  process.stdout.write(
    `#${record.number} ${record.title}\n` +
      `  state    : ${record.state}${record.stateReason ? ` (${record.stateReason})` : ''}\n` +
      `  labels   : ${record.labels.map((label) => label.name).join(', ') || '—'}\n` +
      `  author   : ${record.author?.login ?? '—'}\n` +
      `  comments : ${record.comments?.length ?? 0}\n` +
      `  url      : ${record.url}\n`,
  );

  // Dedup before anything else: an open PR or a revert changes the route
  // before a single line of analysis is worth doing.
  if (linked.length === 0) process.stdout.write('  linked   : no pull requests reference this issue\n');
  for (const pr of linked) {
    process.stdout.write(
      `  linked   : #${pr.number} ${pr.state}${pr.isRevert ? ' [REVERT]' : ''} ${pr.title}\n`,
    );
  }

  // The body, in full, and the comments. This is the reading triage is for,
  // and it was fetched and dropped: the call already asks GitHub for both,
  // and printing a header without them sent the first live run to
  // `gh issue view --json body` for the same issue it had just downloaded.
  //
  // The body is never truncated, and has no setting that would. What a
  // reporter wrote is the requirement, and a summary of it is somebody's
  // reading of the requirement.
  const body = String(record.body ?? '').trim();
  process.stdout.write(`\n${body === '' ? '(the issue has no body)' : body}\n`);

  // The comments are another matter — see commentsToShow.
  const { shown, hidden } = commentsToShow(record.comments ?? [], {
    limit: get(config, 'triage.fetch_comments'),
    full: Boolean(flags.full),
  });
  if (hidden > 0) {
    process.stdout.write(`\n… ${hidden} earlier comment${hidden === 1 ? '' : 's'} not shown; --full to read them all\n`);
  }

  for (const comment of shown) {
    const author = comment.author?.login ?? comment.user?.login ?? 'someone';
    process.stdout.write(`\n--- comment by ${author}${comment.createdAt ? ` on ${comment.createdAt.slice(0, 10)}` : ''} ---\n`);
    process.stdout.write(`${String(comment.body ?? '').trim()}\n`);
  }

  return EXIT.OK;
}

async function history({ issue }, flags) {
  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });

  const report = await archaeology.collect({
    issue,
    repoRoot: repo.root,
    config: repo.config,
    home,
  });

  // Written before printing. This file is what lets the redo route leave
  // triage, and it must record the lookup that happened rather than the one
  // the reader believes happened.
  const path = await archaeology.save(report, { home });

  if (flags.json) printJson(report);
  else process.stdout.write(`${archaeology.format(report)}${path}\n`);

  // Zero even when nothing was found: "no previous attempt" is an answer, and
  // it is the one that says this is not a redo after all.
  return EXIT.OK;
}

async function adopt({ issue }, flags) {
  const target = typeof flags.state === 'string' ? flags.state : 'pr-open';
  const prNumber = typeof flags.pr === 'string' ? Number.parseInt(flags.pr, 10) : null;
  const branch = typeof flags.branch === 'string' ? flags.branch : null;
  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
    process.stderr.write(
      'pdkit issue adopt: --reason "<where this work came from>" is required.\n' +
        '  The states before this one were never passed, and this line is the only account of why.\n',
    );
    return EXIT.ERROR;
  }

  const adopted = await state.adopt(issue, {
    state: /** @type {any} */ (target),
    reason: flags.reason,
    pr: Number.isInteger(prNumber) ? prNumber : null,
    branch,
    route: typeof flags.route === 'string' ? flags.route : undefined,
    home,
  });

  if (!adopted.ok) {
    process.stderr.write(`pdkit issue adopt: ${adopted.error}\n`);
    return EXIT.ERROR;
  }

  // The pull request is recorded too, so the two files agree from the start.
  // An adopted issue whose PR the book does not know is the drift this
  // command exists to end.
  if (Number.isInteger(prNumber)) {
    await pr.register({ issue, number: prNumber, branch, home });
  }

  if (flags.json) printJson(adopted.record);
  else {
    process.stdout.write(
      `issue ${issue}: adopted at ${target}${Number.isInteger(prNumber) ? `, #${prNumber} recorded` : ''}\n` +
        `  No plan, requirements or receipts exist for it, and none are missing: they were never produced.\n` +
        `  Every check that reads them will say so rather than reporting a gap.\n`,
    );
  }
  return EXIT.OK;
}

async function rework({ issue }, flags) {
  if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
    process.stderr.write(
      'pdkit issue rework: --reason "<what the review rejected>" is required.\n' +
        '  The diff still exists and the pull request stays open; this line is the only record of why the\n' +
        '  work is being planned again.\n',
    );
    return EXIT.ERROR;
  }

  const result = await state.transition(issue, 'triaged', { reason: `rework: ${flags.reason.trim()}` });
  if (!result.ok) {
    process.stderr.write(`pdkit issue rework: ${result.error}\n`);
    return EXIT.ERROR;
  }

  process.stdout.write(
    `issue ${issue}: ${result.from} -> triaged, route cleared\n` +
      `  The pull request stays open and the branch stays where it is — what starts again is planning.\n` +
      `  Requirements are thawed: an objection to the approach is usually a requirement nobody wrote down.\n` +
      `  Existing R-IDs keep their numbers. Nothing renumbers, ever.\n`,
  );
  return EXIT.OK;
}

async function blockOrUnblock({ action, issue }, flags) {
  const by = Number.parseInt(String(flags.by ?? '').replace(/^#/, ''), 10);
  const reason = typeof flags.reason === 'string' ? flags.reason : '';
  const result =
    action === 'block' ? await blocks.block({ issue, by, reason }) : await blocks.unblock({ issue, by, reason });

  if (!result.ok) {
    process.stderr.write(`pdkit issue ${action}: ${result.error}\n`);
    return EXIT.ERROR;
  }

  if (action === 'block') {
    process.stdout.write(
      `DESKTOP-${issue} waits on #${by}\n` +
        `  next, pr list and state say so until \`pdkit issue unblock ${issue} --by ${by}\`.\n` +
        `  What does not depend on #${by} can still be fixed and pushed; what does waits for the rebase after it merges.\n`,
    );
  } else {
    process.stdout.write(`DESKTOP-${issue} no longer waits on #${by}\n  next: /pd:resume ${issue}, which rebases onto what landed\n`);
  }
  return EXIT.OK;
}

async function draftBlocker({ issue }, flags) {
  const what = typeof flags.what === 'string' ? flags.what.trim() : '';
  if (!what) {
    process.stderr.write('pdkit issue draft-blocker: --what <text> is required: what the earlier pull request carries\n');
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const pr = Number.parseInt(String(flags.pr ?? ''), 10);
  const slug = ids.slugify(what);
  const path = await render.write({
    issue,
    template: 'blocker',
    path: join('blockers', `${slug}.md`),
    home,
    values: {
      issue,
      slug,
      what,
      raisedBy: typeof flags['raised-by'] === 'string' ? flags['raised-by'] : '—',
      where: Number.isInteger(pr) ? `#${pr}` : `DESKTOP-${issue}`,
      prior: typeof flags.prior === 'string' ? flags.prior : 'none',
      recordedAt: new Date().toISOString().slice(0, 10),
      title: typeof flags.title === 'string' && flags.title.trim() ? flags.title.trim() : titleFrom(what),
      quote: "<the reviewer's words, verbatim>",
      url: typeof flags.url === 'string' ? flags.url : '',
      additionalContext: '<anything else a reader needs>',
    },
  });

  process.stdout.write(
    `${path}\n` +
      '  A draft. Open it upstream yourself (gh issue create is denied at the hook), then:\n' +
      `  pdkit issue block ${issue} --by <the number it got> --reason "${what}"\n`,
  );
  return EXIT.OK;
}

async function listBlocks({ issue }, flags) {
  const found = flags.all ? await blocks.list({ issue }) : await blocks.open({ issue });
  const config = flags.check ? await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined }) : null;

  const rows = [];
  for (const entry of found) {
    let upstream = null;
    if (config && entry.status === 'open') {
      try {
        const read = await gh.fetchIssue(entry.by, { config });
        upstream = { state: read.state, stateReason: read.stateReason ?? null, closedAt: read.closedAt ?? null };
      } catch (error) {
        upstream = { error: String(error?.message ?? error).split('\n')[0] };
      }
    }
    rows.push({ ...entry, upstream });
  }

  if (flags.json) {
    printJson({ issue, blocks: rows });
    return EXIT.OK;
  }
  if (rows.length === 0) {
    process.stdout.write(`DESKTOP-${issue} waits on nothing\n`);
    return EXIT.OK;
  }

  process.stdout.write(`DESKTOP-${issue}\n`);
  for (const row of rows) {
    const since = row.at.slice(0, 10);
    const lifted = row.status === 'lifted' ? `  lifted ${String(row.liftedAt).slice(0, 10)}${row.liftReason ? ` — ${row.liftReason}` : ''}` : '';
    let upstream = '';
    if (row.upstream?.error) upstream = `  github: could not read (${row.upstream.error})`;
    else if (row.upstream) upstream = `  github: ${row.upstream.state}${row.upstream.stateReason ? ` (${row.upstream.stateReason})` : ''}`;
    process.stdout.write(`  #${row.by}  ${row.status}  since ${since}  ${row.reason}${lifted}${upstream}\n`);
  }
  if (rows.some((row) => row.upstream?.state === 'CLOSED')) {
    process.stdout.write(
      '\n  A closed blocker is not lifted here: closed is not always merged. If what this issue waited on has landed,\n' +
        `  pdkit issue unblock ${issue} --by <issue>, then /pd:resume ${issue}.\n`,
    );
  }
  return EXIT.OK;
}

async function escalate({ issue }, flags) {
  const result = await state.transition(issue, 'triaged', {
    reason: typeof flags.reason === 'string' ? flags.reason : 'escalated from quickfix',
  });

  if (!result.ok) {
    process.stderr.write(`pdkit issue escalate: ${result.error}\n`);
    return EXIT.ERROR;
  }

  process.stdout.write(
    `issue ${issue}: ${result.from} -> triaged, route cleared\n` +
      'R-IDs are now allocated from the issue requirements, not from the diff you already wrote.\n',
  );
  return EXIT.OK;
}

async function unknown({ action }) {
  // Not the keys of ACTIONS: the list printed here has always been these three.
  process.stderr.write(`pdkit issue: unknown action "${action ?? ''}" (list, fetch, escalate)\n`);
  return EXIT.ERROR;
}

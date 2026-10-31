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

// `pdkit pr`: open a pull request, and the actions on one that is registered.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parsePlan } from '../artefacts.js';
import * as blocks from '../blocks.js';
import { get, load, paths, resolveHome } from '../config.js';
import * as gh from '../gh.js';
import * as pr from '../pr.js';
import * as render from '../render.js';
import * as threads from '../threads.js';
import { EXIT, issueFlag, openPullRequest, printJson, pullRequestBase, repoContext } from './support.js';

export const flags = ['issue', 'slice', 'branch', 'base', 'title', 'body', 'values', 'thread', 'resolve', 'reason', 'superseded-by', 'by', 'confirm', 'no-logs', 'pr', 'stat'];

/** `pdkit pr` actions, so an unknown one can list what exists. */
const ACTIONS = {
  create,
  register: onePullRequest(register),
  list,
  show: onePullRequest(show),
  refresh: onePullRequest(refresh),
  ci: onePullRequest(ci),
  threads: onePullRequest(listThreads),
  diff: onePullRequest(diff),
  render: onePullRequest(renderTracking),
  reply: onePullRequest(reply),
  merged: onePullRequest(settle),
  closed: onePullRequest(settle),
  supersede: onePullRequest(supersede),
};
const PR_ACTIONS = Object.keys(ACTIONS);

function waitingOn(domains) {
  const open = (domains ?? []).filter((entry) => entry.state === 'inreview').map((entry) => entry.domain);
  return open.length === 0 ? '' : `  waiting:${open.join(',')}`;
}

/**
 * Open a pull request. Not the only command that writes to GitHub: here
 * create, reply and supersede do, and so does publish.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0] ?? '';
  if (!PR_ACTIONS.includes(action)) {
    process.stderr.write(`pdkit pr: unknown action "${action}" (${PR_ACTIONS.join(', ')})\n`);
    return EXIT.ERROR;
  }

  const repoRoot = typeof flags.repo === 'string' ? flags.repo : undefined;
  const home = resolveHome({ repoRoot });
  const config = await load({ repoRoot, home });

  return ACTIONS[action]({ action, args, home, config }, flags);
}

async function create({ home, config }, flags) {
  const issue = issueFlag(flags);
  if (!Number.isInteger(issue) || typeof flags.branch !== 'string' || typeof flags.title !== 'string' || typeof flags.body !== 'string') {
    process.stderr.write('pdkit pr create: --issue, --branch, --title and --body <file> are required\n');
    return EXIT.ERROR;
  }

  const body = await readFile(flags.body, 'utf8');

  const target = await pullRequestBase({ issue, branch: flags.branch, base: flags.base, config, home });
  if (!target.ok) {
    process.stderr.write(`pdkit pr create: ${target.error}`);
    return EXIT.ERROR;
  }

  const { result, unrecorded } = await openPullRequest({ issue, branch: flags.branch, ...target, title: flags.title, body, config, home });
  if (unrecorded) {
    // The PR exists now; refusing to record it would leave the state machine
    // describing a world that is one pull request out of date.
    process.stderr.write(`pdkit pr create: opened ${result.url} but could not record it: ${unrecorded}\n`);
  }

  if (flags.json) printJson(result);
  else process.stdout.write(`${result.url}\n`);

  return EXIT.OK;
}

async function list({ home, config }, flags) {
  const wanted = issueFlag(flags);
  const issues = Number.isInteger(wanted)
    ? [wanted]
    : (await readdir(paths(home).issues).catch(() => []))
        .map((entry) => Number.parseInt(entry, 10))
        .filter((issue) => Number.isInteger(issue))
        .sort((a, b) => a - b);

  const rows = [];
  for (const issue of issues) {
    const book = await pr.read(issue, { home });
    const waitsOn = (await blocks.open({ issue, home })).map((entry) => entry.by);
    for (const record of book?.prs ?? []) {
      rows.push({ issue, ...record, waitsOn, staleness: pr.staleness(record, { config }), reading: pr.reading(record) });
    }
  }

  if (flags.json) {
    printJson({ prs: rows });
  } else if (rows.length === 0) {
    process.stdout.write('no pull requests registered\n');
  } else {
    for (const row of rows) {
      const age = row.staleness.days === null ? '—' : `${row.staleness.days}d`;
      // A record never read from GitHub carries the defaults it was registered
      // with, and `ci:pending review:none threads:0/0` printed as if somebody
      // had looked. Say it was not read instead of what nobody measured.
      const unread = row.reading.at === null;
      // Replaced, not merely closed: the successor is where the work went.
      const state = row.supersededBy ? `superseded by #${row.supersededBy}` : row.state;
      // Only an open pull request can be acted on; an old reading of a closed
      // one is not something to come back to, so it gets no arrow.
      const flag = row.reading.old && row.state === 'open' ? ' ←' : '';
      process.stdout.write(
        `  #${row.number}  DESKTOP-${row.issue}${row.slice === null ? '' : ` slice #${row.slice}`}  ${state}` +
          (unread
            ? '  ci:unread  review:unread  threads:unread'
            : `  ci:${row.ci.verdict}  review:${row.review.decision ?? 'none'}` +
              // "open of total", spelled out: `4/5` was read as four of five
              // resolved on #19849, when four were still waiting.
              `  threads:${row.review.threadsOpen} open of ${row.review.threadsTotal}`) +
          `  idle:${age}${row.staleness.stale ? ' STALE' : ''}` +
          // Who it is waiting on, when it is waiting on people. `ci:pending`
          // reads as "come back later"; this says come back after whom.
          `${waitingOn(row.review.domains)}` +
          // Waiting on another issue's merge, which no refresh will change.
          `${row.waitsOn.length > 0 ? `  waits-on:${row.waitsOn.map((by) => `#${by}`).join(',')}` : ''}` +
          // When this row was read. Every field to its left is local, and a
          // sweep costs 37 seconds, so nobody refreshes before every glance.
          `  read:${row.reading.label}${flag}\n`,
      );
    }
  }

  return EXIT.OK;
}

/**
 * The actions about one pull request: its number, and the issue it is
 * registered under, are resolved before the action runs.
 *
 * @param {(context: object, flags: Record<string, string|boolean>) => Promise<number>} handler
 */
function onePullRequest(handler) {
  return async (context, flags) => {
    const { action, args, home } = context;
    // Everything below is about one pull request.
    const number = Number.parseInt(String(args[1] ?? flags.pr), 10);
    if (!Number.isInteger(number)) {
      process.stderr.write(`pdkit pr ${action}: a pull request number is required\n`);
      return EXIT.ERROR;
    }

    const issue = Number.isInteger(issueFlag(flags))
      ? issueFlag(flags)
      : await pr.issueOf(number, { home });

    if (!Number.isInteger(issue)) {
      process.stderr.write(
        `pdkit pr ${action}: #${number} is not registered under any issue. Pass --issue <n>, or register it with pdkit pr register\n`,
      );
      return EXIT.ERROR;
    }

    return handler({ ...context, number, issue }, flags);
  };
}

async function register({ issue, number, home }, flags) {
  const index = Number.parseInt(String(flags.slice), 10);
  const record = await pr.register({
    issue,
    number,
    slice: Number.isInteger(index) ? index : null,
    branch: typeof flags.branch === 'string' ? flags.branch : null,
    base: typeof flags.base === 'string' ? flags.base : null,
    home,
  });

  if (flags.json) printJson(record);
  else process.stdout.write(`#${record.number} recorded under DESKTOP-${issue}${record.slice === null ? '' : ` as slice #${record.slice}`}\n`);

  return EXIT.OK;
}

async function supersede({ issue, number, home, config }, flags) {
  const by = Number.parseInt(String(flags.by), 10);
  if (!Number.isInteger(by) || typeof flags.body !== 'string') {
    process.stderr.write('pdkit pr supersede: --by <k> and --body <file> are required\n');
    return EXIT.ERROR;
  }

  const book = await pr.read(issue, { home });
  const old = book?.prs.find((entry) => entry.number === number);
  const successor = book?.prs.find((entry) => entry.number === by);
  if (!old || old.state !== 'open') {
    process.stderr.write(`pdkit pr supersede: #${number} is not an open pull request of DESKTOP-${issue} (${old?.state ?? 'not recorded'})\n`);
    return EXIT.ERROR;
  }
  if (!successor || successor.state === 'closed') {
    // The replacement has to exist before the original goes, or the review
    // history points at nothing. Opening it is /pd:pr's job; this one only
    // closes.
    process.stderr.write(`pdkit pr supersede: #${by} is not a live pull request of DESKTOP-${issue}; open and register it first\n`);
    return EXIT.ERROR;
  }

  const body = await readFile(flags.body, 'utf8');
  if (!flags.confirm) {
    process.stdout.write(
      `would close #${number} on ${get(config, 'repo.upstream')} with this comment, and record it as superseded by #${by}:\n\n` +
        `${body.trim().split('\n').map((line) => `  > ${line}`).join('\n')}\n\n` +
        `Show this to the person. Then: pdkit gate open --issue ${issue} --pr ${number} --kind reply, and run again with --confirm.\n`,
    );
    return EXIT.OK;
  }

  await gh.closeSuperseded({ pr: number, body, config, home });
  const record = await pr.markClosed({ issue, number, supersededBy: by, reason: `superseded by #${by}`, home });

  if (flags.json) printJson(record);
  else process.stdout.write(`#${number} closed, superseded by #${by}\n`);
  return EXIT.OK;
}

async function settle({ action, issue, number, home }, flags) {
  const record =
    action === 'merged'
      ? await pr.markMerged({ issue, number, home })
      : await pr.markClosed({
          issue,
          number,
          reason: typeof flags.reason === 'string' ? flags.reason : undefined,
          supersededBy: typeof flags['superseded-by'] === 'string' ? Number.parseInt(flags['superseded-by'], 10) : undefined,
          home,
        });

  const summary = await pr.rollup(issue, { home });

  if (flags.json) printJson({ record, rollup: summary });
  else {
    process.stdout.write(`#${number} is ${record.state}\n`);
    // Said out loud because the issue did NOT move: merge is a fact about a
    // pull request, and an issue with three slices is not finished by one.
    process.stdout.write(
      summary.allMerged
        ? `  every pull request of DESKTOP-${issue} has landed — pdkit close will finish the issue\n`
        : `  DESKTOP-${issue} still has ${summary.unfinished.length} unfinished: ` +
            `${summary.unfinished.map((entry) => `#${entry}`).join(', ')}\n` +
            (summary.superseded.length > 0
              ? `  superseded and settled: ${summary.superseded.map((entry) => `#${entry}`).join(', ')}\n`
              : ''),
    );
  }

  return EXIT.OK;
}

async function refresh({ issue, number, home, config }, flags) {
  const record = await pr.refresh({ issue, number, config, home });

  if (flags.json) printJson(record);
  else {
    // How much of CI has answered, when not all of it has: "ci pending" right
    // after a push reads as a stuck run unless it says it is still arriving.
    const waiting = (record.ci.jobs ?? []).filter((job) => job.notReported).length;
    const reported = waiting > 0 ? ` (${record.ci.jobs.length - waiting} of ${record.ci.jobs.length} jobs reported on this head)` : '';
    process.stdout.write(`#${number} ${record.state}, review ${record.review.decision ?? 'undecided'}, ci ${record.ci.verdict}${reported}\n`);
    for (const job of record.ci.jobs.filter((entry) => entry.verdict !== 'pass')) {
      process.stdout.write(
        `  ${job.verdict === 'fail' ? '✘' : '!'} ${job.name}  ${job.conclusion}` +
          `${job.peers.length ? `  also red on ${job.peers.map((entry) => `#${entry}`).join(', ')}` : ''}\n`,
      );
    }
  }

  return record.ci.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
}

async function show({ issue, number, home, config }, flags) {
  const book = await pr.read(issue, { home });
  const record = book?.prs.find((entry) => entry.number === number);
  if (!record) {
    process.stderr.write(`pdkit pr show: #${number} is not registered under DESKTOP-${issue}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ ...record, staleness: pr.staleness(record, { config }) });
  else process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

  return EXIT.OK;
}

async function ci({ issue, number, home, config }, flags) {
  const record = await pr.refresh({ issue, number, config, home });

  // The verdict says whether the red is ours; the log says what broke, and
  // that is the half scenario 9 leaves to the model. --no-logs exists for the
  // dashboard sweep, where a request per broken job across ten pull requests
  // buys reading nobody asked for.
  const logs = flags['no-logs'] ? [] : await pr.failureLogs(record, { config });

  if (flags.json) {
    printJson({ pr: number, verdict: record.ci.verdict, jobs: record.ci.jobs, logs });
    return record.ci.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
  }

  process.stdout.write(`#${number} CI: ${record.ci.verdict}\n`);
  for (const job of record.ci.jobs) {
    if (job.verdict === 'pass') continue;

    const shared = job.peers.length ? ` — the same job is red on ${job.peers.map((entry) => `#${entry}`).join(', ')}` : '';
    // A job pending since June is a different thing from a job pending since
    // a minute ago, and the word "pending" cannot tell them apart.
    const age =
      job.verdict === 'pending' && job.startedAt
        ? ` — in progress for ${Math.floor((Date.now() - Date.parse(job.startedAt)) / 86_400_000)}d, since ${job.startedAt.slice(0, 10)}`
        : '';

    process.stdout.write(`  ${job.verdict.padEnd(12)} ${job.name}${shared}${age}\n`);
  }

  for (const log of logs) {
    process.stdout.write(`\n  ── ${log.job} — the steps that failed\n`);
    if (!log.available) {
      // Said out loud, because a job printed with no log under it reads as a
      // job that failed on nothing.
      process.stdout.write(`     no log: ${log.reason}\n`);
      if (log.url) process.stdout.write(`     ${log.url}\n`);
      continue;
    }
    if (log.dropped > 0) process.stdout.write(`     … ${log.dropped} earlier line(s) not shown\n`);
    for (const line of log.lines) process.stdout.write(`     ${line}\n`);
    if (log.trailing > 0) process.stdout.write(`     … ${log.trailing} line(s) after this, mostly the runner cleaning up\n`);
    // Which window this is. Anchored on the error marker it contains the
    // failure; a bare tail is the fallback and may not.
    if (log.anchor === 'tail') {
      process.stdout.write('     (no ##[error] in this log — this is the end of it, not necessarily the failure)\n');
    }
  }

  // The distinction the measurement exists for, spelled out where it is read.
  process.stdout.write(
    '\n  fail = red here and green on other open PRs. inconclusive = red on theirs too, so not yours to fix.\n' +
      '  flake = the same job answered twice on one commit.\n' +
      // Only when logs were in play. Explaining the fetching rule under a run
      // that fetched nothing describes a report the reader is not holding.
      (flags['no-logs']
        ? '  --no-logs: no failure text was read for any of these.\n'
        : '  the log is fetched for fail only — on the others the measurement has already answered.\n'),
  );

  return record.ci.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
}

async function diff({ issue, number, home, config }, flags) {
  const repo = await repoContext(flags);
  const result = await pr.pending({ issue, number, cwd: repo.root ?? process.cwd(), config, home, stat: Boolean(flags.stat) });
  if (!result.ok) {
    process.stderr.write(`pdkit pr diff: ${result.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) {
    printJson(result);
    return EXIT.OK;
  }

  const short = (sha) => sha.slice(0, 11);
  const lines = [`#${number} ${result.branch}${result.slice === null ? '' : `, slice #${result.slice}`}`, `  on GitHub : ${short(result.head)}`];
  if (result.ahead === 0 && result.behind === 0) {
    lines.push('  local     : the same commit — nothing to push');
  } else {
    // A rewrite is the normal shape here: pr-sync amends, and the push is a
    // force-with-lease. Said, because "1 ahead" alone reads as an addition.
    const shape = result.behind > 0 ? `${result.ahead} ahead, ${result.behind} behind — a rewrite, pushed with --force-with-lease` : `${result.ahead} ahead`;
    lines.push(`  local     : ${short(result.local)} (${shape})`);
  }
  if (result.outside.length > 0) {
    lines.push(
      `  outside slice #${result.slice} after the push: ${result.outside.join(', ')}`,
      '    the slice graph does not list these — a decision for the person, not a detail of the fix',
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (result.stat) process.stdout.write(`\n${result.stat}\n`);
  if (result.patch) process.stdout.write(`\n${result.patch}\n`);
  return EXIT.OK;
}

/**
 * What `threads` prints and `render` writes: the review threads and the
 * discussion, traced to the plan.
 */
async function reviewFacts({ issue, number, home, config }) {
  const fetched = await gh.reviewThreads(number, { config });
  const discussion = await gh.discussion(number, { config });

  const plan = await parsePlanOf(home, issue);
  const facts = await threads.collect({
    issue,
    pr: number,
    threads: fetched,
    discussion,
    config,
    home,
    satisfies: plan,
  });

  return facts;
}

async function listThreads(context, flags) {
  const facts = await reviewFacts(context);

  if (flags.json) printJson(facts);
  else {
    process.stdout.write(threads.format(facts));
    process.stdout.write(`\n\n  ${facts.counts.unresolvedThreads} unresolved thread(s), ${facts.counts.humans} open item(s) from people\n`);
    if (facts.unmapped.length > 0) {
      process.stdout.write(
        `  ${facts.unmapped.length} item(s) touch a file in no slice — a thread on one, or a review that cites one: either a requirement the plan missed, or a PR that did not explain itself\n`,
      );
    }
  }
  return EXIT.OK;
}

async function renderTracking(context, flags) {
  const { issue, number, home } = context;
  const facts = await reviewFacts(context);

  const book = await pr.read(issue, { home });
  const record = book?.prs.find((entry) => entry.number === number);
  if (!record) {
    process.stderr.write(`pdkit pr render: #${number} is not registered under DESKTOP-${issue}\n`);
    return EXIT.ERROR;
  }

  const path = await render.write({
    issue,
    template: 'prTracking',
    path: join('prs', `${number}.md`),
    home,
    values: {
      ...pr.renderValues(record, { issue, requirements: await pr.requirementsOf(issue, record, { home }) }),
      threads: threads.format(facts, { kinds: ['thread'] }),
      discussion: threads.format(facts, { kinds: ['review', 'comment'] }),
      ...(typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {}),
    },
  });

  process.stdout.write(`${path}\n`);
  return EXIT.OK;
}

async function reply({ number, home, config }, flags) {
  if (typeof flags.thread !== 'string' || typeof flags.body !== 'string') {
    process.stderr.write('pdkit pr reply: --thread <id> and --body <file> are required\n');
    return EXIT.ERROR;
  }

  const body = await readFile(flags.body, 'utf8');
  const result = await gh.replyToThread({
    pr: number,
    threadId: flags.thread,
    body,
    resolve: Boolean(flags.resolve),
    config,
    home,
  });

  if (flags.json) printJson(result);
  else process.stdout.write(`${result.url ?? 'replied'}${result.resolved ? ' (resolved)' : ''}\n`);

  return EXIT.OK;
}

/**
 * Task -> requirements, out of the plan. Used to trace a thread to an R-ID.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<Record<string, string[]>>}
 */
async function parsePlanOf(home, issue) {
  try {
    const text = await readFile(join(paths(home).issues, String(issue), 'plan.md'), 'utf8');
    return Object.fromEntries(parsePlan(text).tasks.map((task) => [task.id, task.satisfies]));
  } catch {
    return {};
  }
}

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

// `pdkit defer`: record what was set aside, list it, and say what settled it.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { paths, resolveHome } from '../config.js';
import * as deferrals from '../deferrals.js';
import * as ids from '../ids.js';
import * as journal from '../journal.js';
import * as render from '../render.js';
import * as state from '../state.js';
import { EXIT, ageOf, issueFlag, printJson, repoContext, titleFrom } from './support.js';

const exec = promisify(execFile);

export const flags = ['issue', 'kind', 'what', 'title', 'raised-by', 'url', 'pr', 'reason', 'follow-up', 'values', 'all'];

const ACTIONS = {
  new: create,
  list,
  resolve: settle,
  drop: settle,
};

/**
 * The host, in the shape upstream's bug form asks for.
 *
 * Auto-filled because it is a fact about the machine that just ran the thing,
 * and a field somebody types from memory is a field that says Ventura eighteen
 * months after they upgraded. The draft says it was auto-filled so it gets
 * corrected when the report is about a platform nobody checked.
 *
 * @returns {Promise<string>}
 */
async function describeHost() {
  const arch = process.arch === 'arm64' ? 'Apple silicon' : process.arch;

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('sw_vers', ['-productVersion']);
      return `macOS ${stdout.trim()} (${arch})`;
    } catch {
      return `macOS (${arch})`;
    }
  }
  return `${process.platform} ${process.arch}`;
}

/**
 * The value upstream's Version dropdown wants.
 *
 * A tree built from source is "next (development version)" in that list, and
 * saying `1.30.0-next` instead would be a value the form does not offer.
 *
 * @param {string|null} repoRoot
 * @returns {Promise<string>}
 */
async function podmanDesktopVersion(repoRoot) {
  if (!repoRoot) return 'next (development version)';

  try {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    return /-next$/.test(String(version)) ? 'next (development version)' : String(version);
  } catch {
    return 'next (development version)';
  }
}

/**
 * The screenshot block for a deferral draft.
 *
 * Every placeholder is **visible text**, never an HTML comment, and that is the
 * whole design of this function. A comment renders as nothing, so one left
 * unreplaced reaches the issue invisibly — the defect this repository has now
 * fixed three times elsewhere (the `Patch comes off` caveat, the config arrays
 * message, `steps-to-check`). Posted unreplaced, a line like this is obvious to
 * the author and to the reader.
 *
 * Files already captured under the issue are named, because knowing which file
 * to drag in is most of the work.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<string>}
 */
async function screenshotPlaceholders(issue, home) {
  const dir = join(paths(home).issues, String(issue), 'evidence');
  const images = (await readdir(dir).catch(() => []))
    .filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name))
    .sort();

  if (images.length === 0) {
    return (
      '**[SCREENSHOT — replace this line, or delete it if there is nothing to show.\n' +
      'Drag the image into the GitHub comment box; it becomes its own `![…](…)` line.]**'
    );
  }

  return [
    `Captured under \`${dir}\` — drag each one in and delete the line it replaces:`,
    '',
    ...images.map((name, index) => `**[SCREENSHOT ${index + 1} — replace this line by dragging in \`${name}\`]**`),
  ].join('\n');
}

/**
 * Record what was set aside, list it, and say what settled it.
 *
 * The command exists because `/pd:pr-sync` has offered `defer` as one of four
 * ways to answer a review thread since it was written, and nothing recorded the
 * choice. See lib/deferrals.js for why the record lives in the journal rather
 * than on the issue.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0] ?? 'list';
  if (!Object.hasOwn(ACTIONS, action)) {
    process.stderr.write(`pdkit defer: unknown action "${action}" (new, list, resolve, drop)\n`);
    return EXIT.ERROR;
  }

  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit defer ${action}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  return ACTIONS[action]({ action, args, issue, home }, flags);
}

async function list({ issue, home }, flags) {
  const found = flags.all ? await deferrals.list({ issue, home }) : await deferrals.open({ issue, home });

  if (flags.json) {
    printJson(found);
    return EXIT.OK;
  }

  process.stdout.write(`DESKTOP-${issue}\n`);
  if (found.length === 0) {
    process.stdout.write(flags.all ? '  nothing was deferred\n' : '  nothing outstanding\n');
    return EXIT.OK;
  }

  for (const entry of found) {
    const settled = entry.status === 'resolved' && entry.followUp ? `#${entry.followUp}` : entry.status;
    const from = [entry.raisedBy, entry.pr ? `#${entry.pr}` : ''].filter(Boolean).join(', ');
    process.stdout.write(`  ${entry.id}  ${settled.padEnd(9)} ${ageOf(entry.at).padStart(5)}   ${from}\n`);
    process.stdout.write(`      ${entry.what}\n`);
    if (entry.status === 'dropped') process.stdout.write(`      dropped: ${entry.outcome}\n`);
  }

  return EXIT.OK;
}

async function create({ issue, home }, flags) {
  // Resolved for the draft rather than for the record: the version field of
  // upstream's bug form comes from the repository being worked on.
  const repo = await repoContext(flags);
  const pr = flags.pr === undefined ? null : Number.parseInt(String(flags.pr), 10);
  if (pr !== null && !Number.isInteger(pr)) {
    process.stderr.write('pdkit defer new: --pr takes a pull request number\n');
    return EXIT.ERROR;
  }

  const record = await state.read(issue, { home });
  if (record.history.length === 0) {
    process.stderr.write(
      `pdkit defer new: DESKTOP-${issue} is not in the machine — check the number, or start it with \`pdkit state ${issue} --to triaged\`\n`,
    );
    return EXIT.ERROR;
  }

  const raisedBy = typeof flags['raised-by'] === 'string' ? flags['raised-by'] : '';
  const url = typeof flags.url === 'string' ? flags.url : '';
  const what = typeof flags.what === 'string' ? flags.what : '';

  // Validated before anything is allocated. Allocation is the one step here
  // that cannot be undone — the counter only goes up — so a command that
  // refuses after taking a number leaves a gap in the sequence, and a missing
  // D2 reads afterwards as a deferral somebody deleted.
  const composed = deferrals.deferredEntry({ id: 'D0', what, pr, raisedBy, url });
  if (!composed.ok) {
    process.stderr.write(`pdkit defer new: ${composed.error}\n`);
    return EXIT.ERROR;
  }

  // Which of upstream's issue forms this will be filed as. The draft is laid
  // out in that form's fields so it can be copied one field at a time into the
  // template in the GitHub UI, and the posted issue reads like every other one
  // in the repository rather than like something a tool generated.
  //
  // Above the allocation, with the rest of the validation. It was below it,
  // which made every refusal here spend a D-ID — the exact gap the comment
  // above says not to leave, on the wrong side of the line it draws. Reading
  // the values file goes up too: a JSON syntax error is the likeliest throw
  // on this path.
  const kind = typeof flags.kind === 'string' ? flags.kind.toLowerCase() : 'bug';
  const template = { bug: 'deferralBug', feature: 'deferralFeature', task: 'deferralTask' }[kind];
  if (!template) {
    process.stderr.write(`pdkit defer new: --kind "${kind}" is not one of bug, feature, task\n`);
    return EXIT.ERROR;
  }

  let values;
  try {
    values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};
  } catch (error) {
    process.stderr.write(`pdkit defer new: --values ${flags.values} could not be read as JSON: ${error.message}\n`);
    return EXIT.ERROR;
  }

  // The ID reaches the journal entry and the draft together: a second D1 would
  // make the follow-up issue, the journal and the reply ambiguous at once.
  const id = await ids.allocateDeferral(issue, { home });

  const path = await render.write({
    issue,
    template,
    path: join('deferrals', `${id}.md`),
    home,
    repoRoot: repo.root ?? undefined,
    values: {
      id,
      issue,
      what,
      raisedBy: raisedBy || '—',
      where: pr ? `#${pr}` : '—',
      recordedAt: new Date().toISOString().slice(0, 10),
      quote: "<the reviewer's words, verbatim>",
      url: url || '',
      title: typeof flags.title === 'string' && flags.title.trim() ? flags.title.trim() : titleFrom(what),
      screenshots: await screenshotPlaceholders(issue, home),
      // Bug form.
      description: what,
      os: await describeHost(),
      installMethod: 'Other',
      version: await podmanDesktopVersion(repo.root),
      steps: '<numbered, each an action with an expected result>',
      logs: '<paste, do not summarise; leave empty if there is none>',
      additionalContext: '<anything else a reader needs>',
      // Feature form.
      problem: what,
      solution: '<what a person should see, not what the code should contain>',
      alternatives: '<including the rejected ones, and why>',
      // Task form.
      content: what,
      ...values,
    },
  });

  // The journal is written last, and the order is the whole point. It is
  // append-only, so a mistaken entry is not one anything takes back — while a
  // draft that failed to render can simply be rendered again. Writing the
  // entry first, which is what this did until a render error proved it, leaves
  // a deferral the journal knows about and no file to open.
  const written = await deferrals.defer({ issue, id, what, pr, raisedBy, url, home });
  if (!written.ok) {
    process.stderr.write(`pdkit defer new: ${written.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ id, issue, path, what });
  else {
    process.stdout.write(`${id}  DESKTOP-${issue}  deferred\n`);
    process.stdout.write(`  ${what}\n`);
    if (raisedBy || pr) process.stdout.write(`  raised by ${[raisedBy, pr ? `#${pr}` : ''].filter(Boolean).join(' on ')}\n`);
    process.stdout.write(`  ${path}\n\n`);
    process.stdout.write(
      '  Recorded, not resolved. The draft is for the follow-up issue; opening it is yours,\n' +
        '  and `gh issue create` is denied at the hook from every state.\n' +
        `  \`pdkit defer resolve ${id} --issue ${issue} --follow-up <n>\` once it exists.\n`,
    );
  }

  return EXIT.OK;
}

async function settle({ action, args, issue, home }, flags) {
const followUp = action === 'resolve' ? Number.parseInt(String(flags['follow-up']), 10) : null;
if (action === 'resolve' && !Number.isInteger(followUp)) {
  process.stderr.write('pdkit defer resolve: --follow-up <issue> is required — a deferral is settled by the issue that took it on\n');
  return EXIT.ERROR;
}

const settled = await deferrals.settle({
  issue,
  id: String(args[1] ?? ''),
  followUp: action === 'resolve' ? followUp : null,
  reason: typeof flags.reason === 'string' ? flags.reason : '',
  home,
});

if (!settled.ok) {
  process.stderr.write(`pdkit defer ${action}: ${settled.error}\n`);
  return EXIT.ERROR;
}

if (flags.json) printJson(settled.entry);
else process.stdout.write(`${journal.formatEntry(settled.entry)}\n`);

return EXIT.OK;
}

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

// Facts about someone else's pull request (spec section 4, /pd:review-pr).
//
// The same division as lib/audit.js and lib/threads.js: collect() gathers, and
// nothing here decides. There is no verdict field, no severity, no "looks
// fine" — a collector that graded its own findings would be pre-empting the
// four axes it exists to feed, and worse, it would do it with a grep.
//
// What is mechanical about reviewing a change is narrow and worth doing
// exactly once: which layers it spans, whether it touches the public API,
// whether it changed schemas without regenerating them, whether new files
// carry their licence header, and what reviewers have already said. What is
// not mechanical is everything the report is actually for.
//
// One rule here is a deliberate omission rather than a feature: commit scope is
// not reported. Upstream does not require it (section 7) — it is our own
// discipline — and spending an author's attention on a rule their project does
// not have is how a review loses the authority to raise the ones it does.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { get, load, paths, resolveHome } from './config.js';
import * as gh from './gh.js';
import { write as writeArtefact } from './render.js';
import { changedPaths, commits as readCommits, fetchPullRequestHead, layerFor, packageFor, readPackageMap } from './repo.js';
import { botFrom, escalationsIn, summarise } from './threads.js';
import { EXTENSION_API_DTS, checkSpdx, classifyApiSurface } from './upstream.js';

/** Files whose change is supposed to be accompanied by generated output. */
const SCHEMA = /schema|\.schema\.[a-z]+$/i;

/** What `pnpm generate:schemas` writes, and therefore what should move with it. */
const GENERATED = /(^|\/)(generated|dist)\//;

/** An exported declaration, for the API-surface question. */
const EXPORTED = /^\+\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Issue references a pull request body names with a keyword. */
const REFERENCES = /(?:closes|fixes|resolves|part of|refs?)\s+#(\d+)/gi;

/**
 * The heading upstream's pull request template gives to issue references, and
 * the bare `#16802` contributors write under it.
 *
 * A keyword pattern alone misses that, and so does GitHub: a bare number under
 * a heading is a link, not a closing reference, so it appears in neither
 * `closingIssuesReferences` nor REFERENCES. Read the section instead. Scoping
 * it to that one heading is what keeps it from swallowing every `#123` in a
 * paragraph about some other pull request.
 */
const ISSUES_HEADING = /^what issues does this pr/i;

/** A bare issue number, only ever applied inside the section above. */
const BARE_REFERENCE = /#(\d+)/g;

/** Template guidance the author left in place, which names no issue. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * The body of the pull request template's issue-references section.
 *
 * @param {string} body
 * @returns {string} empty when the template was not used, or the heading renamed
 */
function issuesSection(body) {
  const sections = body.split(/^#{1,6}\s+/m);
  return (sections.find((section) => ISSUES_HEADING.test(section)) ?? '').replace(HTML_COMMENT, '');
}

/**
 * Every issue a pull request points at, from the three places it can say so.
 *
 * GitHub's own `closingIssuesReferences` comes first because it is the only
 * one of the three that is authoritative — it is what the merge will actually
 * close. The other two exist because a pull request that says "part of #16794"
 * or fills in the template without a keyword is still telling us what to read,
 * and reading the wrong issue is the one way the Requirement fit table gets
 * worse than being empty.
 *
 * @param {object} pull
 * @returns {number[]} in the order they were found, deduped
 */
function referencedIssues(pull) {
  const body = String(pull.body ?? '');

  const found = [
    ...(pull.closingIssuesReferences ?? []).map((entry) => Number(entry?.number)),
    ...[...body.matchAll(REFERENCES)].map((match) => Number(match[1])),
    ...[...issuesSection(body).matchAll(BARE_REFERENCE)].map((match) => Number(match[1])),
  ];

  return [...new Set(found.filter((number) => Number.isInteger(number) && number > 0))];
}

/**
 * The mechanical half of reviewing somebody else's pull request: facts, no
 * verdict.
 *
 * Everything here is a query result — which layers it spans, whether it touches
 * the public API, whether the schemas were regenerated, which issues it claims
 * to fix. The judgement is the four review agents' and the exit code is always
 * zero, because a verdict reached here would be one reached before anybody read
 * the diff.
 *
 * @typedef {object} Report
 * @property {number} pr
 * @property {object} pull            what GitHub says about it
 * @property {{base: string, ref: string, files: Array<{status: string, path: string}>}} diff
 * @property {Array<{layer: string, files: string[]}>} layers
 * @property {{touched: boolean, files: string[], symbols: Array<{symbol: string, public: boolean, declaredAt: string|null}>}} api
 * @property {{touched: string[], generated: string[]}} schemas
 * @property {string[]} missingSpdx
 * @property {number[]} references    issues this pull request points at
 * @property {Array<{number: number, title: string|null, state: string|null, url: string|null, body: string|null}>} issues
 *                                    those issues, read; null fields mean unreadable
 * @property {object|null} feedback   the threads already on it, bots folded
 */

/**
 * Gather what a review does not need a model to establish.
 *
 * The diff is local. `refs/pull/<k>/head` is fetched and read with git, which
 * is the same primitive `--from-pr` uses (section 4) — a published change
 * becomes readable by giving it a local ref to be, not by inventing a second
 * way to describe a diff.
 *
 * @param {{pr: number, repoRoot: string, config?: object, home?: string, exec?: Function, fetch?: boolean}} input
 * @returns {Promise<Report>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome({ repoRoot: input.repoRoot });
  const config = input.config ?? (await load({ repoRoot: input.repoRoot, home }));
  const options = { config, exec: input.exec };

  const pull = await gh.pullRequest(input.pr, { ...options, fields: gh.PR_REVIEW_FIELDS });

  const fetched =
    input.fetch === false
      ? { ref: pull.headRefOid, base: pull.baseRefName, baseBranch: pull.baseRefName }
      : await fetchPullRequestHead({ pr: input.pr, repoRoot: input.repoRoot, config });

  const files = await changedPaths(fetched.base, fetched.ref, { cwd: input.repoRoot });
  const paths_ = files.filter((entry) => entry.status !== 'D').map((entry) => entry.path);

  let packageMap = { packages: {}, layers: [] };
  try {
    packageMap = await readPackageMap({ home });
  } catch {
    // No map: layers come back as unknown rather than guessed. A review that
    // invented a layout would put the change in the wrong reviewer's lap.
  }

  const layerOrder = get(config, 'slicing.layer_order') ?? packageMap.layers ?? [];

  /** @type {Map<string, string[]>} */
  const byLayer = new Map();
  for (const path of paths_) {
    const owner = await packageFor(path, { home, map: packageMap });
    const layer = owner ? (owner.layer ?? layerFor(owner.path, layerOrder)) : 'unknown';
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), path]);
  }

  const apiFiles = paths_.filter((path) => path === EXTENSION_API_DTS);
  // Classified against the public surface as it stands here, not at their ref.
  // The question is whether the symbol they touched is public in upstream
  // today; a symbol this pull request itself adds to the .d.ts is caught by
  // `api.touched` instead, and answered by the api-compat axis.
  const symbols = await exportedSymbols({ repoRoot: input.repoRoot, base: fetched.base, ref: fetched.ref });

  const missingSpdx = [];
  for (const entry of files.filter((file) => file.status === 'A')) {
    // From the ref, not from disk. Their pull request is not checked out here —
    // the working tree is ours — so reading the path would answer about a file
    // this change may not even have.
    const contents = await show({ repoRoot: input.repoRoot, ref: fetched.ref, path: entry.path });
    if (contents === null) continue;

    const verdict = checkSpdx({ path: entry.path, content: contents });
    if (verdict.required && !verdict.present) missingSpdx.push(entry.path);
  }

  const references = referencedIssues(pull);

  // The issues themselves, not just their numbers. The skill tells the four
  // axes to read the linked issue, and until this was here that instruction
  // could only be followed by hand — which meant it was followed when someone
  // remembered. A reference that names a deleted issue, or one in another
  // tracker, comes back with null fields rather than throwing — and stays in
  // the list, because "there is an issue here and I could not read it" is
  // something the axes need told, not something to drop quietly.
  const issues = [];
  for (const number of references) {
    try {
      const issue = await gh.fetchIssue(number, options);
      issues.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.url,
        body: issue.body ?? '',
      });
    } catch {
      issues.push({ number, title: null, state: null, url: null, body: null });
    }
  }

  return {
    pr: input.pr,
    pull: {
      number: pull.number,
      title: pull.title,
      author: pull.author,
      state: pull.state,
      isDraft: pull.isDraft,
      url: pull.url,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changedFiles,
      reviewDecision: pull.reviewDecision ?? null,
      checks: pull.checks ?? [],
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
    },
    diff: { base: fetched.base, ref: fetched.ref, files },
    layers: [...byLayer.entries()]
      .map(([layer, entries]) => ({ layer, files: entries }))
      .sort((left, right) => layerOrder.indexOf(left.layer) - layerOrder.indexOf(right.layer)),
    api: { touched: apiFiles.length > 0, files: apiFiles, symbols: await classifyApiSurface({ symbols, repoRoot: input.repoRoot }) },
    schemas: {
      touched: paths_.filter((path) => SCHEMA.test(path) && !GENERATED.test(path)),
      generated: paths_.filter((path) => GENERATED.test(path)),
    },
    missingSpdx,
    commits: await readCommits(fetched.base, fetched.ref, { cwd: input.repoRoot }),
    references,
    issues,
    feedback: await feedbackFor({ pr: input.pr, config, exec: input.exec, home }),
  };
}

/**
 * One file as it stands at a ref.
 *
 * @param {{repoRoot: string, ref: string, path: string}} input
 * @returns {Promise<string|null>} null when the ref does not have it
 */
async function show(input) {
  try {
    const { stdout } = await promisify(execFile)('git', ['show', `${input.ref}:${input.path}`], {
      cwd: input.repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Symbols this pull request adds to some file's exports.
 *
 * Taken from added lines of the diff rather than from the files as they stand:
 * what matters is what this change introduced, and a file's existing exports
 * are not the author's to answer for.
 *
 * @param {{repoRoot: string, base: string, ref: string}} input
 * @returns {Promise<string[]>}
 */
async function exportedSymbols(input) {
  let diff = '';
  try {
    const { stdout } = await promisify(execFile)('git', ['diff', '--unified=0', `${input.base}...${input.ref}`], {
      cwd: input.repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    diff = stdout;
  } catch {
    return [];
  }

  const symbols = new Set();
  for (const line of diff.split('\n')) {
    const match = EXPORTED.exec(line);
    if (match) symbols.add(match[1]);
  }

  return [...symbols];
}

/**
 * What reviewers have already said, bots folded.
 *
 * Included so the four axes do not repeat a point somebody made a week ago —
 * the fastest way for a review to read as automated.
 *
 * Only the bot half of lib/threads.js applies here, and that is the whole
 * difference between reviewing someone else's pull request and syncing our
 * own. Mapping a thread to a slice, a task and an R-ID needs a plan; this
 * change has none of ours, and pretending otherwise would report every thread
 * as belonging to nothing.
 *
 * @param {{pr: number, config: object, exec?: Function}} input
 * @returns {Promise<{threads: object[], comments: object[], counts: object}|null>}
 */
async function feedbackFor(input) {
  const options = { config: input.config, exec: input.exec };

  let raw;
  let discussion;
  try {
    raw = await gh.reviewThreads(input.pr, options);
    discussion = await gh.discussion(input.pr, options);
  } catch {
    // A token without the GraphQL scope, or a pull request with no discussion
    // at all. Neither is a reason to withhold the rest of the facts.
    return null;
  }

  const fold = (source, extra = {}) => {
    const bot = botFrom(source, input.config);
    const escalated = bot ? escalationsIn(source.body ?? '', input.config) : [];
    return {
      author: source.author ?? null,
      isBot: bot,
      // A collapsed bot is still a line with a link, never a removal.
      collapsed: bot && escalated.length === 0,
      escalated,
      digest: summarise(source.body ?? ''),
      ...extra,
    };
  };

  const threads = raw.map((thread) =>
    fold(thread, { path: thread.path ?? null, line: thread.line ?? null, isResolved: Boolean(thread.isResolved) }),
  );
  const comments = [
    ...discussion.reviews.map((review) => fold(review, { kind: 'review', state: review.state ?? null })),
    ...discussion.comments.map((comment) => fold(comment, { kind: 'comment' })),
  ];

  return {
    threads,
    comments,
    counts: {
      total: threads.length + comments.length,
      human: [...threads, ...comments].filter((entry) => !entry.isBot).length,
      bot: [...threads, ...comments].filter((entry) => entry.isBot).length,
      open: threads.filter((entry) => !entry.isResolved).length,
      escalated: [...threads, ...comments].filter((entry) => entry.escalated.length > 0).length,
    },
  };
}

/**
 * Render a report for a terminal.
 *
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const lines = [
    `review: #${report.pr} ${report.pull.title}`,
    `  author       : ${report.pull.author ?? '—'}${report.pull.isDraft ? ' (draft)' : ''}`,
    `  size         : +${report.pull.additions} −${report.pull.deletions} across ${report.pull.changedFiles} file(s)`,
    `  diff         : ${report.diff.base.slice(0, 9)}...${report.diff.ref.slice(0, 9)}`,
    `  decision     : ${report.pull.reviewDecision ?? 'none yet'}`,
    '',
    '  layers:',
  ];

  for (const entry of report.layers) {
    lines.push(`    ${entry.layer.padEnd(14)} ${entry.files.length} file(s)`);
  }
  if (report.layers.length > 1) {
    lines.push('    (more than one layer means more than one reviewer — worth saying in the review)');
  }

  lines.push('');
  if (report.api.touched) {
    lines.push('  ✱ extension-api.d.ts is touched: backwards compatibility and disposal are in scope');
  }
  const publicSymbols = report.api.symbols.filter((entry) => entry.public);
  if (publicSymbols.length > 0) {
    lines.push('  ✱ exported symbols that are part of the public API:');
    for (const entry of publicSymbols) lines.push(`      ${entry.symbol} — ${entry.declaredAt}`);
  }
  if (report.schemas.touched.length > 0 && report.schemas.generated.length === 0) {
    lines.push('  ✱ schemas changed with no generated output in the diff');
    for (const path of report.schemas.touched) lines.push(`      ${path}`);
  }
  if (report.missingSpdx.length > 0) {
    lines.push('  ✱ added files with no SPDX header:');
    for (const path of report.missingSpdx) lines.push(`      ${path}`);
  }
  if (report.references.length > 0) {
    lines.push('  issues referenced:');
    for (const number of report.references) {
      const issue = (report.issues ?? []).find((entry) => entry.number === number);
      lines.push(`      #${number} ${issue?.title ?? '(could not be read)'}`);
    }
  } else {
    // Said out loud, because the alternative is a Requirement fit table filled
    // from the diff — which agrees with itself by construction and finds
    // nothing missing.
    lines.push('  ✱ no issue referenced: Requirement fit has nothing to check against');
  }

  if (report.feedback) {
    lines.push(
      '',
      `  already said : ${report.feedback.counts.human} human thread(s), ` +
        `${report.feedback.counts.bot} from bots, ${report.feedback.counts.open} still open`,
    );
  }

  lines.push(
    '',
    '  These are facts, not a review. What is left is what no grep answers:',
    '  whether the change fits, whether it is in the right layer, whether the',
    '  tests cover what was claimed, and whether it does what the issue asked.',
    '',
  );

  return lines.join('\n');
}

/**
 * Write reviews/<pr>.md from templates/review-report.md.
 *
 * The verdict and every section come from the caller — this is the one artefact
 * of the plugin whose content really is the model's, because a review IS a
 * judgement. What the code contributes is the shape: the requirement-fit table
 * and, in particular, `What I could not verify`, which the template refuses to
 * let go missing.
 *
 * @param {{pr: number, values: Record<string, unknown>, home?: string}} input
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function render(input) {
  const home = input.home ?? resolveHome();

  const path = await writeArtefact({
    issue: input.pr,
    template: 'reviewReport',
    root: paths(home).reviews,
    path: `${input.pr}.md`,
    home,
    values: { pr: input.pr, ...input.values },
  });

  return { ok: true, path };
}

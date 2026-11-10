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

// `pdkit self-review`: what to review, and the record that it was reviewed.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';

import { resolveHome } from '../config.js';
import * as preflight from '../preflight/index.js';
import * as selfReview from '../self-review.js';
import { EXIT, issueFlag, printJson, repoContext } from './support.js';

export const flags = ['issue', 'slice', 'findings', 'body'];

export const ACTIONS = {
  target,
  record,
  show,
};

/**
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0] ?? '';

  if (!Object.hasOwn(ACTIONS, action)) {
    process.stderr.write(`pdkit self-review: unknown action "${action}" (target, record, show)\n`);
    return EXIT.ERROR;
  }

  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit self-review ${action}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  const slice = flags.slice === undefined ? undefined : Number.parseInt(String(flags.slice), 10);
  if (slice !== undefined && !Number.isInteger(slice)) {
    process.stderr.write(`pdkit self-review ${action}: --slice takes a number\n`);
    return EXIT.ERROR;
  }

  return ACTIONS[action]({ action, issue, slice }, flags);
}

/**
 * The base, ref and commit preflight will check, resolved the way preflight
 * resolves them. The review and the check have to agree on what was under
 * review, and the only way to be sure they do is to ask the same function.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 */
async function resolveTarget(context, flags) {
  const repo = await repoContext(flags);
  if (!repo.root) return { ok: false, error: repo.problems.join('; ') };

  const prepared = await preflight.prepare({ issue: context.issue, slice: context.slice, repoRoot: repo.root });
  if (prepared.problem) return { ok: false, error: prepared.problem };
  if (prepared.headSha === null) return { ok: false, error: `${prepared.ref} does not resolve to a commit` };

  return { ok: true, base: prepared.base, ref: prepared.ref, sha: prepared.headSha, slice: prepared.slice, files: prepared.changedFiles };
}

/**
 * What the axes read: `git diff <base>...<ref>`, at this commit.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function target(context, flags) {
  const resolved = await resolveTarget(context, flags);
  if (!resolved.ok) {
    process.stderr.write(`pdkit self-review target: ${resolved.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ base: resolved.base, ref: resolved.ref, sha: resolved.sha, slice: resolved.slice, files: resolved.files });
  else {
    process.stdout.write(`diff:   git diff ${resolved.base}...${resolved.ref}\n`);
    process.stdout.write(`commit: ${resolved.sha}\n`);
    process.stdout.write(`files:  ${resolved.files.length}\n${resolved.files.map((file) => `  ${file}`).join('\n')}\n`);
  }
  return EXIT.OK;
}

/**
 * Record what the synthesis returned, against the commit preflight will check
 * and the body about to be published.
 *
 * The commit is resolved here, never passed in: a review recorded against a
 * sha somebody typed would prove whatever they typed.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function record(context, flags) {
  if (typeof flags.findings !== 'string' || typeof flags.body !== 'string') {
    process.stderr.write('pdkit self-review record: --findings <file.json> and --body <file> are required\n');
    return EXIT.ERROR;
  }

  let given;
  let body;
  try {
    given = JSON.parse(await readFile(flags.findings, 'utf8'));
    body = await readFile(flags.body, 'utf8');
  } catch (error) {
    process.stderr.write(`pdkit self-review record: ${error.message}\n`);
    return EXIT.ERROR;
  }

  const resolved = await resolveTarget(context, flags);
  if (!resolved.ok) {
    process.stderr.write(`pdkit self-review record: ${resolved.error}\n`);
    return EXIT.ERROR;
  }

  const result = await selfReview.record({
    issue: context.issue,
    slice: resolved.slice,
    sha: resolved.sha,
    body,
    axes: given?.axes,
    findings: given?.findings,
    home: resolveHome(),
  });

  if (!result.ok) {
    process.stderr.write(`pdkit self-review record: ${result.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ sha: resolved.sha, findings: result.entry.findings.length, unresolved: result.unresolved });
  else {
    process.stdout.write(`recorded for ${resolved.sha.slice(0, 8)}: ${result.entry.findings.length} finding(s), ${result.unresolved.length} open\n`);
    for (const finding of result.unresolved) {
      process.stdout.write(`  ${finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''} — ` : ''}${finding.label}: ${finding.text}\n`);
    }
    if (result.unresolved.length > 0) {
      process.stdout.write('\nThe self-review preflight check stays red until a review of a later commit finds none of these.\n');
    }
  }

  // Recording is a success whatever was found: the record is true either way,
  // and the check is where open findings stop the push.
  return EXIT.OK;
}

/**
 * The recorded entry for this pull request.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function show(context, flags) {
  const entry = selfReview.entryFor(await selfReview.read(context.issue, { home: resolveHome() }), context.slice);

  if (entry === null) {
    if (flags.json) printJson(null);
    else process.stdout.write('no self-review recorded for this pull request\n');
    return EXIT.OK;
  }

  const open = selfReview.unresolved(entry);
  if (flags.json) printJson({ ...entry, unresolved: open });
  else {
    process.stdout.write(`${entry.sha.slice(0, 8)}, ${entry.recordedAt}: ${entry.findings.length} finding(s), ${open.length} open\n`);
    for (const finding of entry.findings) {
      const state = open.includes(finding) ? 'open' : finding.label === 'question' ? 'answered' : 'pre-existing';
      process.stdout.write(`  [${state}] ${finding.path ?? ''}${finding.line ? `:${finding.line}` : ''} ${finding.label}: ${finding.text}\n`);
    }
  }
  return EXIT.OK;
}

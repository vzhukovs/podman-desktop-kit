// SPDX-License-Identifier: Apache-2.0

// Preflight check: slice standalone
//
// A slice that branches from main must build and pass on its own, because that
// is what a reviewer will see. This check does not run that build — it reads
// the verification `pdkit slice verify` recorded and asks two questions the
// stored result cannot answer about itself:
//
//   is it still about this diff?   the digest is recomputed here
//   is its evidence real?          the attached run is validated here
//
// Both matter more than the green tick. A verification that is not re-checked
// decays into "was verified once", which is exactly the kind of proof
// lib/evidence.js exists to refuse — and on a materialized branch a digest
// mismatch also means the branch is not what was verified.

import { issueDir } from '../../config.js';
import { validateReceipt } from '../../evidence.js';
import { checkFreshness } from '../../slice.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @type {string} */
export const id = 'slice-standalone';

/** @type {boolean} */
export const blocking = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (!context.sliceGraph) {
    return { id, status: 'skip', blocking, summary: 'this issue has no slice graph; single-PR work has nothing to verify standalone' };
  }

  const slice = context.sliceRecord;
  if (!slice) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: `the graph has ${context.sliceGraph.slices.length} slice(s), but this run is not about any of them`,
      remedy: 'pass --slice <i>, or run preflight while standing on the slice branch',
    };
  }

  const verification = slice.verification;
  if (!verification) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `slice #${slice.index} has never been verified`,
      remedy: `pdkit slice verify --issue ${context.issue} --slice ${slice.index}`,
    };
  }

  const fresh = await checkFreshness({
    graph: context.sliceGraph,
    index: slice.index,
    repoRoot: context.repoRoot,
    base: context.base,
    ref: context.ref,
  });

  if (!fresh.fresh) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the verification of slice #${slice.index} is stale: ${fresh.reason}`,
      remedy:
        `pdkit slice verify --issue ${context.issue} --slice ${slice.index}. ` +
        'On a materialized branch this also means the branch no longer matches the slice that was verified',
    };
  }

  const evidence = await evidenceProblem(context, slice);
  if (evidence) return { id, status: 'fail', blocking, summary: evidence.summary, remedy: evidence.remedy };

  if (!verification.ok) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `slice #${slice.index} did not pass its ${verification.standalone ? 'standalone' : 'stacked'} build (exit ${verification.exitCode ?? 'killed'})`,
      remedy:
        verification.standalone && slice.baseSlice === null
          ? 'either fix what it depends on, or stack it on the slice that introduces it and re-verify'
          : `read ${verification.evidence} under the issue; the run is attached in full`,
    };
  }

  if (slice.baseSlice === null && !verification.standalone) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `slice #${slice.index} branches from ${context.sliceGraph.source.base} but was only verified stacked`,
      remedy: `pdkit slice verify --issue ${context.issue} --slice ${slice.index} --standalone`,
    };
  }

  const revert = verification.revertsCleanly === false ? ', does NOT revert cleanly' : '';
  return {
    id,
    status: 'pass',
    blocking,
    summary: `slice #${slice.index} ${verification.standalone ? 'standalone' : 'stacked'} on ${context.base}, verified ${verification.verifiedAt}${revert}`,
  };
}

/**
 * Whether the run attached to a verification is still a real capture.
 *
 * @param {import('../index.js').PreflightContext} context
 * @param {import('../../slice.js').Slice} slice
 * @returns {Promise<{summary: string, remedy: string}|null>}
 */
async function evidenceProblem(context, slice) {
  const path = slice.verification?.evidence;
  if (!path) {
    return {
      summary: `slice #${slice.index} has a verification with no run attached`,
      remedy: `pdkit slice verify --issue ${context.issue} --slice ${slice.index}`,
    };
  }

  let content;
  try {
    content = await readFile(join(issueDir(context.home, context.issue), path), 'utf8');
  } catch {
    return {
      summary: `the run recorded for slice #${slice.index} is missing (${path})`,
      remedy: `pdkit slice verify --issue ${context.issue} --slice ${slice.index}`,
    };
  }

  const checked = validateReceipt(content);
  if (!checked.ok) {
    return { summary: `the run recorded for slice #${slice.index} is not a valid capture: ${checked.reason}`, remedy: 'verify again; the record is written by pdkit and validates by arithmetic' };
  }

  return null;
}

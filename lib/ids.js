// SPDX-License-Identifier: Apache-2.0

// Allocation and freezing of R-IDs, task IDs, and slice IDs.
//
// R-IDs are allocated once and never renumbered. They trace requirement -> task
// -> commit -> the coverage table in the PR body. Renumbering breaks every link
// at once, so the freeze after plan approval is enforced here, not asked for in
// a prompt.
//
// On the quickfix route no R-IDs are allocated at all: tracing goes by issue
// number. When a quickfix escalates to standard, R-IDs are derived from the
// issue's requirements — never from the diff that already exists. IDs read off
// a finished diff describe what was built, not what was required, and the whole
// trace becomes self-confirming.
//
// The record itself is owned by lib/state.js: this module formats and refuses,
// it does not write. Both rules that can refuse an allocation — the freeze and
// the route — live with the record, so they cannot go stale between the check
// and the write.

import { get, loadSync } from './config.js';
import * as state from './state.js';

/**
 * The shape preflight enforces on a branch name. Exported so the check and the
 * generator cannot drift apart; two copies of this pattern means every PR
 * eventually fails its own gate.
 */
export const BRANCH_PATTERN = /^DESKTOP-\d+\/(\d+-)?[a-z0-9-]+$/;

/**
 * Turn an outcome from lib/state.js into a value or an exception.
 *
 * Refusals are exceptions here on purpose: a caller asking for an ID has no
 * sensible way to continue without one, unlike a caller asking for a
 * transition, which has to report the refusal to the user.
 *
 * @template T
 * @param {{ok: boolean, error?: string}} result
 * @param {(result: any) => T} pick
 * @returns {T}
 */
function unwrap(result, pick) {
  if (!result.ok) throw new Error(result.error);
  return pick(result);
}

/**
 * Allocate the next free R-ID for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<string>} e.g. "R4"
 * @throws when the requirement set is frozen, or the issue is on quickfix
 */
export async function allocateRequirement(issue, options = {}) {
  return unwrap(await state.allocateRequirement(issue, options), (result) => `R${result.value}`);
}

/**
 * Freeze the requirement set. Called on plan approval.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<string[]>} the frozen IDs
 */
export async function freezeRequirements(issue, options = {}) {
  return unwrap(await state.freezeRequirements(issue, options), (result) => result.ids);
}

/**
 * Allocate a task ID (T1, T2, ...) within an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<string>}
 */
export async function allocateTask(issue, options = {}) {
  return unwrap(await state.allocateCounter(issue, 'task', options), (result) => `T${result.value}`);
}

/**
 * Allocate a slice ID. Slices are numbered by merge order, starting at 1.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<number>}
 */
export async function allocateSlice(issue, options = {}) {
  return unwrap(await state.allocateCounter(issue, 'slice', options), (result) => result.value);
}

/**
 * Reduce a title to the slug part of a branch name.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Branch name for a slice, per the `branches` config templates.
 *
 * @param {{issue: number, index?: number, slug: string, config?: import('./config.js').Config}} parts
 * @returns {string} e.g. "DESKTOP-12345/2-main-exec-plumbing"
 */
export function branchName(parts) {
  const config = parts.config ?? loadSync();
  const sliced = parts.index !== undefined && parts.index !== null;
  const template = get(config, sliced ? 'branches.sliced' : 'branches.single');

  if (typeof template !== 'string') {
    throw new Error(`config: branches.${sliced ? 'sliced' : 'single'} is not set`);
  }

  const slug = slugify(parts.slug);
  if (slug === '') throw new Error('branchName: the slug is empty after normalization');

  const name = template
    .replaceAll('{issue}', String(parts.issue))
    .replaceAll('{index}', String(parts.index))
    .replaceAll('{slug}', slug);

  // The generator checking itself against the pattern preflight uses is the
  // cheapest place to catch a config template that produces branches every PR
  // would then be rejected for.
  if (!BRANCH_PATTERN.test(name)) {
    throw new Error(`branchName: "${name}" does not match the pattern preflight enforces`);
  }

  return name;
}

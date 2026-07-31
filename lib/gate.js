// SPDX-License-Identifier: Apache-2.0

// Consent tokens for writes to GitHub.
//
// A token is issued for ONE branch, expires after a short TTL, and is spent on
// first use. Consent to push slice #1 is not consent to push slice #2, and
// consent given ten minutes ago is not consent now.
//
// The TTL is not a security measure — anyone can ask again. It exists so
// approval cannot be accumulated: a token you have to request in the moment is
// a token you are more likely to read the diff for.
//
// One file per branch, which is what makes "a token is for one branch" a
// property of the layout rather than a check that could be forgotten. There is
// no index to fall out of sync with the files.
//
// Everything here fails closed. An unreadable token file, a clock that moved,
// a branch that does not parse — all of them mean no valid token, because the
// cost of a wrong "invalid" is one more confirmation and the cost of a wrong
// "valid" is a push nobody reviewed.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { get, load, paths, resolveHome } from './config.js';
import { parseBranch } from './ids.js';
import { append as appendJournal } from './journal.js';
import * as state from './state.js';

/** Default lifetime of a token. Overridable via gates.push_ttl. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** `10m`, `30s`, `1h`. A bare number is milliseconds. */
const DURATION = /^(\d+)\s*(ms|s|m|h)?$/;

const UNIT_MS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };

/**
 * Parse a duration from the config.
 *
 * @param {unknown} value
 * @returns {number|null} milliseconds, or null when it does not parse
 */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const match = DURATION.exec(String(value ?? '').trim());
  if (!match) return null;

  return Number.parseInt(match[1], 10) * UNIT_MS[match[2] ?? 'ms'];
}

/**
 * Where a branch's token lives.
 *
 * The branch is percent-encoded rather than having its slashes swapped for
 * something else: an encoding that can collide would let a token issued for
 * one branch be found for another, which is the single thing this file exists
 * to prevent.
 *
 * @param {string} home
 * @param {string} branch
 * @returns {string}
 */
function tokenPath(home, branch) {
  return join(paths(home).gates, `${encodeURIComponent(branch)}.json`);
}

/**
 * How long a token lives, from config.
 *
 * @param {{home?: string}} options
 * @returns {Promise<number>}
 */
async function ttlFromConfig(options) {
  try {
    const config = await load({ home: options.home });
    return parseDuration(get(config, 'gates.push_ttl')) ?? DEFAULT_TTL_MS;
  } catch {
    // A broken config must not silently produce a longer-lived token than the
    // default. It also must not stop the flow: doctor reports the config.
    return DEFAULT_TTL_MS;
  }
}

/**
 * @typedef {object} Token_
 * @property {string} token
 * @property {string} branch
 * @property {number} issue
 * @property {number|null} slice
 * @property {string} issuedAt
 * @property {string} expiresAt
 * @property {string|null} spentAt
 */

/**
 * Read a branch's token record.
 *
 * @param {string} home
 * @param {string} branch
 * @returns {Promise<Token_|null>}
 */
async function readToken(home, branch) {
  try {
    return JSON.parse(await readFile(tokenPath(home, branch), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Issue a token for a branch.
 *
 * Refuses unless the issue is in a gate-eligible state and the branch belongs
 * to that issue. Both conditions are checked here rather than trusted from the
 * caller: a skill that forgot one would produce a token that looks exactly like
 * a valid one.
 *
 * The gate-eligible set comes from lib/state.js, not from the config. Section 1
 * states it as a hard rule, and a rule that can be widened by editing a YAML
 * file is not a hard rule.
 *
 * @param {{issue: number, branch: string, slice?: number, ttlMs?: number, home?: string}} input
 * @returns {Promise<{ok: boolean, token?: string, expiresAt?: string, error?: string}>}
 */
export async function open(input) {
  const home = input.home ?? resolveHome();
  const branch = String(input.branch ?? '');
  const parts = parseBranch(branch);

  if (!parts) {
    return { ok: false, error: `"${branch}" is not a branch pdkit issues tokens for (expected DESKTOP-<issue>/[<index>-]<slug>)` };
  }
  if (parts.issue !== input.issue) {
    return { ok: false, error: `branch ${branch} belongs to issue ${parts.issue}, not ${input.issue}` };
  }

  const record = await state.read(input.issue, { home });
  if (!state.GATE_ELIGIBLE.includes(record.state)) {
    return {
      ok: false,
      error: `issue ${input.issue} is ${record.state}; a token is only issued from ${state.GATE_ELIGIBLE.join(', ')}`,
    };
  }

  const now = Date.now();
  const ttlMs = input.ttlMs ?? (await ttlFromConfig({ home }));
  /** @type {Token_} */
  const token = {
    token: randomBytes(16).toString('hex'),
    branch,
    issue: input.issue,
    slice: input.slice ?? parts.index,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    spentAt: null,
  };

  await mkdir(paths(home).gates, { recursive: true });
  await writeFile(tokenPath(home, branch), `${JSON.stringify(token, null, 2)}\n`);

  await appendJournal(
    { issue: input.issue, slice: token.slice, event: 'gate-open', detail: `${branch}, valid ${Math.round(ttlMs / 1000)}s` },
    { home },
  );

  return { ok: true, token: token.token, expiresAt: token.expiresAt };
}

/**
 * Check a token against a branch without spending it.
 *
 * `token` is optional: the pre-bash hook knows the branch it is about to push
 * but never sees a token string, so for it the question is whether a valid
 * unspent token exists at all.
 *
 * @param {{branch: string, token?: string, home?: string, now?: number}} input
 * @returns {Promise<{valid: boolean, reason?: string, record?: Token_}>}
 */
export async function verify(input) {
  const home = input.home ?? resolveHome();
  const branch = String(input.branch ?? '');

  const record = await readToken(home, branch);
  if (!record) return { valid: false, reason: `no consent token for ${branch}` };

  // The file is named after the branch, so this can only disagree if someone
  // edited it by hand. Fail closed and say so rather than trusting the name.
  if (record.branch !== branch) {
    return { valid: false, reason: `the token stored for ${branch} names ${record.branch}` };
  }
  if (record.spentAt) {
    return { valid: false, reason: `the token for ${branch} was already spent at ${record.spentAt}` };
  }

  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt)) return { valid: false, reason: `the token for ${branch} has no readable expiry` };
  if (expiresAt <= (input.now ?? Date.now())) {
    return { valid: false, reason: `the token for ${branch} expired at ${record.expiresAt}` };
  }
  if (input.token !== undefined && input.token !== record.token) {
    return { valid: false, reason: `the token given does not match the one issued for ${branch}` };
  }

  return { valid: true, record };
}

/**
 * Spend a token. Spending twice fails the second time, which is the behaviour
 * the push hook depends on: one token, one push.
 *
 * @param {string} branch
 * @param {{home?: string, now?: number}} [options]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function close(branch, options = {}) {
  const home = options.home ?? resolveHome();

  const checked = await verify({ branch, home, now: options.now });
  if (!checked.valid) return { ok: false, error: checked.reason };

  const spent = { ...checked.record, spentAt: new Date(options.now ?? Date.now()).toISOString() };
  await writeFile(tokenPath(home, branch), `${JSON.stringify(spent, null, 2)}\n`);

  await appendJournal(
    { issue: spent.issue, slice: spent.slice, event: 'gate-spent', detail: branch },
    { home },
  );

  return { ok: true };
}

/**
 * Drop every outstanding token.
 *
 * Called by doctor and on session start, so a token cannot survive a crash — or
 * a coffee break — into the next session. That is the whole point of the TTL,
 * and a leftover file would quietly undo it.
 *
 * @param {{home?: string}} [options]
 * @returns {Promise<number>} how many were revoked
 */
export async function revokeAll(options = {}) {
  const home = options.home ?? resolveHome();
  const directory = paths(home).gates;

  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }

  let revoked = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    await rm(join(directory, entry), { force: true });
    revoked += 1;
  }

  return revoked;
}

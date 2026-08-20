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

/**
 * The writes one push token authorises, each at most once.
 *
 * Publishing a branch takes two commands — `git push`, then `gh pr create` —
 * and until now the first spent the token and the second was refused by it. The
 * `/pd:pr` skill has documented that exact pair since it was written, so the
 * documented sequence could not work. It was found by running it, on
 * DESKTOP-18832, at the worst possible moment: the branch was already public
 * and the refusal arrived afterwards, leaving the one state worse than either
 * outcome — a pushed branch with no pull request to explain it.
 *
 * Issuing a second token would have been the other repair, and it is the wrong
 * one. What a human reads at `gate open` is step 6 of `/pd:pr` — the body and
 * the branch, together — so the consent already covers both writes. Asking
 * again splits one reading into two confirmations, which is the fatigue
 * section 4 says a gate cannot afford, and the second confirmation would arrive
 * after the irreversible half had happened.
 *
 * What is emphatically not relaxed is **one token, one push**. The uses are
 * spent separately: a token that has pushed cannot push again, only do the
 * other thing it was granted for, once.
 *
 * And the order is fixed, not symmetric. `pr` spends the token whole, so the
 * push may precede the pull request and never follow it — otherwise a token
 * that had opened a pull request would still carry a push, which would land new
 * commits on a branch already under review with nobody confirming them.
 */
export const PUSH_USES = ['push', 'pr'];

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
 * What a token is for: a branch to push, or a pull request to reply on.
 *
 * A reply belongs to no branch. Threading it onto the branch key anyway would
 * mean a push token and a reply token could be found for one another, and the
 * whole point of the kinds is that consent to publish code is not consent to
 * publish a sentence.
 *
 * @param {{branch?: string, pr?: number, kind?: string}} input
 * @returns {{kind: string, subject: string, key: string}|null}
 */
export function subjectOf(input) {
  const kind = input.kind ?? (input.pr !== undefined && input.branch === undefined ? 'reply' : 'push');

  if (kind === 'push') {
    const branch = String(input.branch ?? '');
    return branch === '' ? null : { kind, subject: branch, key: `push:${branch}` };
  }
  if (kind === 'reply') {
    const pr = Number.parseInt(String(input.pr), 10);
    return Number.isInteger(pr) ? { kind, subject: `#${pr}`, key: `reply:pr-${pr}` } : null;
  }

  return null;
}

/**
 * Where a token lives.
 *
 * The key is percent-encoded rather than having its slashes swapped for
 * something else: an encoding that can collide would let a token issued for
 * one branch be found for another, which is the single thing this file exists
 * to prevent.
 *
 * @param {string} home
 * @param {string} key
 * @returns {string}
 */
function tokenPath(home, key) {
  return join(paths(home).gates, `${encodeURIComponent(key)}.json`);
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
 * @property {string} kind          push | reply
 * @property {string} key
 * @property {string|null} branch
 * @property {number|null} pr
 * @property {number} issue
 * @property {number|null} slice
 * @property {string} issuedAt
 * @property {string} expiresAt
 * @property {string|null} spentAt
 */

/**
 * Read a token record by key.
 *
 * @param {string} home
 * @param {string} key
 * @returns {Promise<Token_|null>}
 */
async function readToken(home, key) {
  try {
    return JSON.parse(await readFile(tokenPath(home, key), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Issue a token.
 *
 * Refuses unless the issue is in a state eligible for that kind of write, and —
 * for a push — unless the branch belongs to that issue. Both are checked here
 * rather than trusted from the caller: a skill that forgot one would produce a
 * token indistinguishable from a valid one.
 *
 * The eligible states come from lib/state.js, not from the config. Section 1
 * states them as a hard rule, and a rule that can be widened by editing a YAML
 * file is not a hard rule.
 *
 * @param {{issue: number, branch?: string, pr?: number, kind?: string, slice?: number, ttlMs?: number, home?: string}} input
 * @returns {Promise<{ok: boolean, token?: string, expiresAt?: string, kind?: string, subject?: string, error?: string}>}
 */
export async function open(input) {
  const home = input.home ?? resolveHome();

  // The kind is checked before the subject: an unknown kind must not fall
  // through to the push branch of the error message and read as a malformed
  // branch name, which is a different problem with a different fix.
  if (input.kind !== undefined && !state.GATE_KINDS.includes(input.kind)) {
    return { ok: false, error: `"${input.kind}" is not a kind of write pdkit issues tokens for (${state.GATE_KINDS.join(', ')})` };
  }

  const target = subjectOf(input);
  if (!target) {
    return {
      ok: false,
      error:
        input.kind === 'reply'
          ? 'a reply token needs --pr <number>'
          : `"${input.branch ?? ''}" is not a branch pdkit issues tokens for (expected DESKTOP-<issue>/[<index>-]<slug>)`,
    };
  }

  const parts = target.kind === 'push' ? parseBranch(target.subject) : null;
  if (target.kind === 'push') {
    if (!parts) {
      return { ok: false, error: `"${target.subject}" is not a branch pdkit issues tokens for (expected DESKTOP-<issue>/[<index>-]<slug>)` };
    }
    if (parts.issue !== input.issue) {
      return { ok: false, error: `branch ${target.subject} belongs to issue ${parts.issue}, not ${input.issue}` };
    }
  }

  const record = await state.read(input.issue, { home });
  const allowed = state.GATE_ELIGIBLE[target.kind];
  if (!allowed.includes(record.state)) {
    return {
      ok: false,
      error: `issue ${input.issue} is ${record.state}; a ${target.kind} token is only issued from ${allowed.join(', ')}`,
    };
  }

  const now = Date.now();
  const ttlMs = input.ttlMs ?? (await ttlFromConfig({ home }));
  /** @type {Token_} */
  const token = {
    token: randomBytes(16).toString('hex'),
    kind: target.kind,
    key: target.key,
    branch: target.kind === 'push' ? target.subject : null,
    pr: target.kind === 'reply' ? Number.parseInt(String(input.pr), 10) : null,
    issue: input.issue,
    slice: input.slice ?? parts?.index ?? null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    spentAt: null,
    // Per use for a push, so the branch and the pull request that publishes it
    // are one consent and two single-use writes. A reply token has no uses: it
    // covers the batch that was read in one go and expires with the TTL.
    spent: target.kind === 'push' ? Object.fromEntries(PUSH_USES.map((use) => [use, null])) : {},
  };

  await mkdir(paths(home).gates, { recursive: true });
  await writeFile(tokenPath(home, target.key), `${JSON.stringify(token, null, 2)}\n`);

  await appendJournal(
    {
      issue: input.issue,
      slice: token.slice,
      event: 'gate-open',
      detail: `${target.kind} ${target.subject}, valid ${Math.round(ttlMs / 1000)}s`,
    },
    { home },
  );

  return { ok: true, token: token.token, expiresAt: token.expiresAt, kind: target.kind, subject: target.subject };
}

/**
 * Check a token without spending it.
 *
 * `token` is optional: the pre-bash hook knows the branch it is about to push
 * but never sees a token string, so for it the question is whether a valid
 * unspent token exists at all.
 *
 * @param {{branch?: string, pr?: number, kind?: string, token?: string, home?: string, now?: number}} input
 * @returns {Promise<{valid: boolean, reason?: string, record?: Token_}>}
 */
export async function verify(input) {
  const home = input.home ?? resolveHome();

  const target = subjectOf(input);
  if (!target) return { valid: false, reason: 'no branch or pull request was named' };

  const record = await readToken(home, target.key);
  if (!record) return { valid: false, reason: `no consent token for ${target.kind} ${target.subject}` };

  // The file is named after the key, so these can only disagree if someone
  // edited it by hand. Fail closed and say so rather than trusting the name.
  if ((record.kind ?? 'push') !== target.kind) {
    return { valid: false, reason: `the token stored for ${target.subject} is a ${record.kind} token, not ${target.kind}` };
  }
  if (target.kind === 'push' && record.branch !== target.subject) {
    return { valid: false, reason: `the token stored for ${target.subject} names ${record.branch}` };
  }
  if (target.kind === 'reply' && `#${record.pr}` !== target.subject) {
    return { valid: false, reason: `the token stored for ${target.subject} names #${record.pr}` };
  }
  if (record.spentAt) {
    return { valid: false, reason: `the token for ${target.subject} was already spent at ${record.spentAt}` };
  }

  // A push token is spent per use, so the same consent covers the push and the
  // pull request it exists for — and neither twice. Asked without naming a use,
  // the question is "is there anything left in this token", which is what
  // `pdkit gate verify` and a bare probe mean.
  if (target.kind === 'push') {
    const spent = record.spent ?? {};
    if (input.use !== undefined) {
      if (spent[input.use]) {
        return {
          valid: false,
          reason:
            `the token for ${target.subject} already ${input.use === 'push' ? 'pushed' : 'opened a pull request'} at ${spent[input.use]}` +
            `${input.use === 'push' ? ' — a second push is a second publication, and needs consent of its own' : ''}`,
        };
      }
    } else if (PUSH_USES.every((use) => spent[use])) {
      return { valid: false, reason: `the token for ${target.subject} has nothing left: it pushed and opened a pull request` };
    }
  }

  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt)) return { valid: false, reason: `the token for ${target.subject} has no readable expiry` };
  if (expiresAt <= (input.now ?? Date.now())) {
    return { valid: false, reason: `the token for ${target.subject} expired at ${record.expiresAt}` };
  }
  if (input.token !== undefined && input.token !== record.token) {
    return { valid: false, reason: `the token given does not match the one issued for ${target.subject}` };
  }

  return { valid: true, record };
}

/**
 * Spend a token. Spending twice fails the second time, which is the behaviour
 * the push hook depends on: one token, one push.
 *
 * A reply token is the one exception, and it is deliberate. The unit of consent
 * for a push is the branch, because each branch is a separately published
 * artefact; the unit for replies is the batch the human read in one go, so the
 * token covers that batch and expires with the TTL rather than on first use. A
 * token per thread would mean confirming eight times in a row, and a gate that
 * is expensive to pass is a gate people route around (section 4).
 *
 * @param {string|{branch?: string, pr?: number, kind?: string}} target
 * @param {{home?: string, now?: number}} [options]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function close(target, options = {}) {
  const home = options.home ?? resolveHome();
  const input = typeof target === 'string' ? { branch: target, kind: 'push' } : target;

  const resolved = subjectOf(input);
  if (!resolved) return { ok: false, error: 'no branch or pull request was named' };

  const use = resolved.kind === 'push' ? (options.use ?? 'push') : null;
  if (use !== null && !PUSH_USES.includes(use)) {
    return { ok: false, error: `"${use}" is not something a push token authorises (${PUSH_USES.join(', ')})` };
  }

  const checked = await verify({ ...input, use: use ?? undefined, home, now: options.now });
  if (!checked.valid) return { ok: false, error: checked.reason };

  const at = new Date(options.now ?? Date.now()).toISOString();
  // A push token records which of its two writes has happened; a reply token is
  // spent whole, because what it authorised was one batch of drafts.
  //
  // Opening the pull request spends the whole thing, and the order is the
  // reason. The consent is for one publication — push this branch, open its
  // pull request — so the push may come before the pull request and not after
  // it. Left merely half-spent, a token that had opened a PR would still carry
  // a push, and that push would put new commits on a pull request under review
  // with nobody confirming them in the moment. Found by a test that had encoded
  // the old rule as "one token, one write", which turned out to be the right
  // rule for the wrong reason.
  const spent =
    use === null || use === 'pr'
      ? { ...checked.record, spentAt: at, spent: { ...(checked.record.spent ?? {}), ...(use ? { [use]: at } : {}) } }
      : { ...checked.record, spent: { ...(checked.record.spent ?? {}), [use]: at } };

  await writeFile(tokenPath(home, resolved.key), `${JSON.stringify(spent, null, 2)}\n`);

  await appendJournal(
    { issue: spent.issue, slice: spent.slice, event: 'gate-spent', detail: `${resolved.kind}${use ? `:${use}` : ''} ${resolved.subject}` },
    { home },
  );

  return { ok: true };
}

/**
 * Every token file on disk, with the record it holds.
 *
 * Unreadable files come back with a null record rather than being skipped: a
 * token nothing can parse is still a file occupying a key, and the two callers
 * — revoking for one issue, revoking the lot — both need to remove it.
 *
 * @param {{home?: string}} [options]
 * @returns {Promise<Array<{file: string, record: Token_|null}>>}
 */
async function tokenFiles(options = {}) {
  const directory = paths(options.home ?? resolveHome()).gates;

  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = join(directory, entry);
    try {
      found.push({ file, record: JSON.parse(await readFile(file, 'utf8')) });
    } catch {
      found.push({ file, record: null });
    }
  }

  return found;
}

/**
 * The tokens issued for one issue, spent or not.
 *
 * Matched on the `issue` field inside the record rather than on the file name.
 * The name is the key — `push:DESKTOP-18548/foo`, `reply:pr-18561` — and a reply
 * token's key names a pull request, which says nothing about the issue unless
 * you already have `prs.json` in hand. The field is written by `open` from the
 * issue it was asked about, so it is the answer rather than an inference from
 * it.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<Token_[]>}
 */
export async function issuedFor(issue, options = {}) {
  return (await tokenFiles(options))
    .map((entry) => entry.record)
    .filter((record) => record !== null && record.issue === issue);
}

/**
 * Drop the tokens issued for one issue, and only those.
 *
 * The narrow counterpart of {@link revokeAll}, for `pdkit reset`: forgetting an
 * issue while a live token for its branch stays on disk would leave consent
 * behind for work the plugin no longer knows it granted it for.
 *
 * A token whose record does not parse is left alone here, unlike in
 * `revokeAll`. It cannot be attributed to this issue, and this command's whole
 * promise is that it touches nothing belonging to another one.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<string[]>} the keys that were dropped
 */
export async function revokeFor(issue, options = {}) {
  const dropped = [];

  for (const entry of await tokenFiles(options)) {
    if (entry.record?.issue !== issue) continue;
    await rm(entry.file, { force: true });
    dropped.push(entry.record.key ?? entry.file);
  }

  return dropped;
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
  const files = await tokenFiles(options);

  for (const entry of files) await rm(entry.file, { force: true });

  return files.length;
}

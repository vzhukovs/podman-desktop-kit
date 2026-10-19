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

// UserPromptSubmit handler.
//
// One question: which issue is this turn about, and does the tree agree. The
// number exists in exactly one place — the command the person typed — and no
// other hook sees it. SessionStart fires on /clear, before the prompt, so the
// best it can do on an ambiguous disk is say it does not know; this is where
// the answer arrives.
//
// Found on DESKTOP-18915: every session after plan-approved opened in a main
// checkout standing on 18967's branch, and the first answer took
// `/pd:preflight 18915` for a typo, because everything in its context was
// about 18967.
//
// The contract, because this is the one hook that reads what a person types:
//   - only a `/pd:<skill> <number>` command is looked at, and only when the
//     skill's argument-hint says the number is an issue or a pull request;
//   - nothing is written — no state, no journal, no file in $PDKIT_HOME;
//   - it never blocks. On this event a block discards the prompt, and a plugin
//     that eats what somebody typed is one they uninstall;
//   - everything else returns before any git call or file read, because it
//     runs on every prompt and its cost is added to every message.

import { resolveHome } from '../config.js';

/**
 * The `/pd:` command at the start of a prompt, as the host delivers it.
 *
 * Two shapes, because the transcript holds a slash command expanded into tags
 * and the raw line is what a person typed; which one the hook receives is the
 * host's business, and both say the same thing.
 */
const TYPED = /^\s*\/pd:([a-z][a-z-]*)[ \t]+#?(\d+)\b/;
const EXPANDED = /<command-name>\/?pd:([a-z][a-z-]*)<\/command-name>[\s\S]*?<command-args>\s*#?(\d+)\b/;

/**
 * Read the skill and its number from a prompt, or null when it is not a
 * `/pd:` command with a number.
 *
 * @param {string} prompt
 * @returns {{skill: string, number: number}|null}
 */
export function parseCommand(prompt) {
  const match = TYPED.exec(prompt) ?? EXPANDED.exec(prompt);
  if (!match) return null;
  return { skill: match[1], number: Number.parseInt(match[2], 10) };
}

/**
 * What a skill's argument is, from its argument-hint, or null when it takes
 * neither an issue nor a pull request number first.
 *
 * `/pd:triage` writes it optional (`[<issue-number|url>]`), and that is still
 * an issue number when one is given.
 *
 * @param {string|null} hint
 * @returns {'issue'|'pr'|null}
 */
export function argumentKind(hint) {
  if (!hint) return null;
  if (/^\[?<issue-number\b/.test(hint)) return 'issue';
  if (/^\[?<pr-number\b/.test(hint)) return 'pr';
  return null;
}

/**
 * Say where the issue named in the prompt lives, when it is not this tree.
 *
 * Quiet on every other outcome. The tree being the issue's is the normal case
 * and SessionStart has already described it; an issue that nothing names yet
 * leaves nowhere to point, and the command itself will say what to create.
 * A pull request number that is not registered under any issue — somebody
 * else's, for `/pd:review-pr` — is not about an issue of ours at all.
 *
 * @param {object|null} payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision & {message?: string}>}
 */
export async function handle(payload, context) {
  // `prompt` is the documented field; `user_prompt` is the name older plugin
  // material uses. Reading both costs nothing and survives either.
  const prompt = payload?.prompt ?? payload?.user_prompt;
  if (typeof prompt !== 'string') return { block: false };

  const command = parseCommand(prompt);
  if (!command) return { block: false };

  // Loaded here rather than at the top: everything above runs on every prompt,
  // and git and the state directory are only worth touching for a command.
  const { skillArgument } = await import('../session-model.js');
  const kind = argumentKind(await skillArgument(command.skill, context.pluginRoot || undefined));
  if (!kind) return { block: false };

  const home = resolveHome();
  let issue = command.number;
  if (kind === 'pr') {
    const { issueOf } = await import('../pr.js');
    const found = await issueOf(command.number, { home }).catch(() => null);
    if (found === null) return { block: false };
    issue = found;
  }

  const cwd = payload?.cwd ?? process.cwd();
  const { forIssue } = await import('../worktree.js');
  const tree = await forIssue({ issue, cwd });
  if (tree.verdict !== 'foreign' || !tree.home) return { block: false };

  const { read: readState } = await import('../state.js');
  const record = await readState(issue, { home }).catch(() => null);
  const status = record?.createdAt ? ` — ${record.state}${record.route ? `, ${record.route}` : ''}` : '';

  const here = `${tree.here.path} on ${tree.here.branch ?? 'a detached HEAD'}`;
  const where =
    tree.home.source === 'worktree'
      ? `${tree.home.path} on ${tree.home.branch ?? 'a detached HEAD'}`
      : `${tree.home.branch}, a local branch checked out nowhere`;

  const lines = [
    `pdkit: /pd:${command.skill} is about issue ${issue}${status}, and this tree is not its.`,
    `  here    : ${here}${tree.here.issue === null ? '' : ` — issue ${tree.here.issue}'s`}`,
    `  ${String(issue).padEnd(8)}: ${where}`,
    tree.home.source === 'worktree'
      ? `  Commands that take ${issue} refuse in this tree; run them from ${tree.home.path}. The issue number in the command is not a typo.`
      : `  Commands that take ${issue} refuse in this tree; check out ${tree.home.branch} or give it a worktree (pdkit worktree create --issue ${issue} --branch ${tree.home.branch}). The issue number in the command is not a typo.`,
  ];

  return { block: false, message: lines.join('\n') };
}

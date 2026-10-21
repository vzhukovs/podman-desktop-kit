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
// A second question since 0.9.1: is the session on the model the phase is
// routed to. A skill's `model:` lasts its first turn and `/model` is typed by a
// person, so the person is told, in a line Claude Code shows them rather than
// the model (`notice`, sent as systemMessage).
//
// The contract, because this is the one hook that reads what a person types:
//   - only a `/pd:<skill>` command is looked at. The tree question needs a
//     number the skill's argument-hint says is an issue or a pull request; the
//     model question needs only the skill;
//   - nothing is written to $PDKIT_HOME — no state, no journal. The one write is
//     a list of the transcripts this `claude` process has had, in the system
//     temp directory, because the model survives `/clear` and the transcript
//     does not;
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
 * Move the session to the issue named in the prompt, when it is not in that
 * issue's tree.
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

  const skill = parseSkill(prompt);
  if (!skill) return { block: false };

  // Loaded here rather than at the top: everything above runs on every prompt,
  // and git, transcripts and the state directory are only worth touching for a
  // command.
  const notice = await modelNotice(skill, payload, context).catch(() => null);
  const message = await treeMessage(prompt, payload, context);

  return {
    block: false,
    ...(message || notice
      ? {
          message: [message, notice ? `pdkit told the person: ${notice.replace(/^pdkit: /, '')} You cannot switch the model yourself; carry on with the command.` : null]
            .filter(Boolean)
            .join('\n'),
        }
      : {}),
    ...(notice ? { notice } : {}),
  };
}

/**
 * The `/pd:` skill at the start of a prompt, with or without an argument, or
 * null.
 *
 * @param {string} prompt
 * @returns {string|null}
 */
export function parseSkill(prompt) {
  return (/^\s*\/pd:([a-z][a-z-]*)(?=\s|$)/.exec(prompt) ?? /<command-name>\/?pd:([a-z][a-z-]*)<\/command-name>/.exec(prompt))?.[1] ?? null;
}

/**
 * A line for the person when the session is not on the model the skill is
 * routed to, or null.
 *
 * Quiet whenever it cannot tell: a reminder that guesses wrong is one people
 * learn to skip. The one assumption it makes is the fork's own default from
 * `pdkit init`, for the first command of a fresh `claude`, and it says so.
 * Haiku skills are left alone: `editor` and `open` finish in the one turn the
 * frontmatter covers.
 *
 * @param {string} skill
 * @param {object|null} payload
 * @param {{pluginRoot: string, env?: Record<string, string|undefined>, sessionsDir?: string}} context
 * @returns {Promise<string|null>}
 */
async function modelNotice(skill, payload, context) {
  const { currentModel, familyOf, readSettings, skillModel } = await import('../session-model.js');
  const wanted = familyOf(await skillModel(skill, context.pluginRoot || undefined));
  if (!wanted || wanted === 'haiku') return null;

  const env = context.env ?? process.env;
  const now = await currentModel({ transcriptPath: payload?.transcript_path ?? null, pid: env.CLAUDE_PID ?? null, dir: context.sessionsDir });

  let model = now.model;
  let assumed = false;
  if (!model) {
    const { list } = await import('../worktree.js');
    const cwd = payload?.cwd ?? process.cwd();
    const main = (await list(cwd)).find((tree) => tree.main)?.path ?? cwd;
    const read = await readSettings(main).catch(() => null);
    model = read?.ok ? familyOf(/** @type {string|undefined} */ (read.settings?.model)) : null;
    assumed = model !== null;
  }

  if (!model || model === wanted) return null;
  const on = assumed ? `most likely started on ${model}, the fork's default` : `is on ${model}`;
  return `pdkit: /pd:${skill} runs on ${wanted}, and this session ${on} — type /model ${wanted} now. A skill's model lasts its first turn; /model lasts the session.`;
}

/**
 * Where the issue named in the command lives, as context for Claude, or null
 * when the tree is the issue's or the command names no issue of ours.
 *
 * @param {string} prompt
 * @param {object|null} payload
 * @param {{pluginRoot: string}} context
 * @returns {Promise<string|null>}
 */
async function treeMessage(prompt, payload, context) {
  const command = parseCommand(prompt);
  if (!command) return null;

  const { skillArgument } = await import('../session-model.js');
  const kind = argumentKind(await skillArgument(command.skill, context.pluginRoot || undefined));
  if (!kind) return null;

  const home = resolveHome();
  let issue = command.number;
  if (kind === 'pr') {
    const { issueOf } = await import('../pr.js');
    const found = await issueOf(command.number, { home }).catch(() => null);
    if (found === null) return null;
    issue = found;
  }

  const cwd = payload?.cwd ?? process.cwd();
  const { enterDirections, forIssue } = await import('../worktree.js');
  const tree = await forIssue({ issue, cwd });
  if (tree.verdict !== 'foreign' || !tree.home) return null;

  const { read: readState } = await import('../state.js');
  const record = await readState(issue, { home }).catch(() => null);
  const status = record?.createdAt ? ` — ${record.state}${record.route ? `, ${record.route}` : ''}` : '';

  const here = `${tree.here.path} on ${tree.here.branch ?? 'a detached HEAD'}`;
  const where = {
    worktree: `${tree.home.path} on ${tree.home.branch ?? 'a detached HEAD'}`,
    checkout: `${tree.home.branch}, held by the main checkout — a template, not a tree to work in`,
    branch: `${tree.home.branch}, a local branch checked out nowhere`,
  }[tree.home.source];

  const lines = [
    `pdkit: /pd:${command.skill} is about issue ${issue}${status}, and this tree is not its.`,
    `  here    : ${here}${tree.here.main ? ' — the main checkout' : ''}${tree.here.issue === null ? '' : ` — issue ${tree.here.issue}'s`}`,
    `  ${String(issue).padEnd(8)}: ${where}`,
    ...entering(await enterDirections(tree).catch(() => null), issue),
  ];

  return lines.join('\n');
}

/**
 * The instruction that moves the session, as message lines.
 *
 * An instruction, not a pointer, because a pointer was what this hook gave
 * before and the session carried on where it stood: the commands refuse in the
 * wrong tree, but subagents edit files wherever the session is, and on
 * DESKTOP-18915 that was the main checkout. The plugin the person installed is
 * the one telling Claude to switch, which is what EnterWorktree asks for.
 * Commands that change a checkout are shown before they run: they move a
 * branch, and that is the person's to agree to.
 *
 * @param {{path: string, steps: string[]}|null} directions
 * @param {number} issue
 * @returns {string[]}
 */
function entering(directions, issue) {
  if (!directions) return [`  Work on ${issue} from its own tree; commands that take ${issue} refuse here. The issue number is not a typo.`];

  const lines = ['  Before anything else, move this session into the issue\'s tree. Do not cd, and do not run the command here.'];
  if (directions.steps.length > 0) {
    lines.push('  1. The tree does not exist yet. Show the person these commands and run them once they agree:');
    for (const step of directions.steps) lines.push(`       ${step}`);
    lines.push(`  2. Call the EnterWorktree tool with path: ${directions.path}`);
  } else {
    lines.push(`  Call the EnterWorktree tool with path: ${directions.path}`);
  }
  lines.push('  Subagents started after the switch work there too. Then carry on with the command as typed.');
  return lines;
}

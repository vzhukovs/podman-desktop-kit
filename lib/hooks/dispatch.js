// SPDX-License-Identifier: Apache-2.0

// PreToolUse handler for every Bash call.
//
// One entry in hooks.json, all rules here. The matcher cannot see the command
// string (spec section 6), so this module parses it and decides.
//
// Which rule applies is decided by lib/hooks/rules.js. What this module adds is
// the part that needs the world: which branch the write would land on, whether
// a consent token exists for it, and spending that token so it cannot be used
// twice.
//
// FAILING CLOSED. lib/cli.js allows a Bash call when a handler cannot be loaded
// or throws — deliberately, so a half-built plugin does not brick every command
// (see the plugin-structure plan). That policy is right for a handler that has
// not decided anything, and wrong once a rule has matched: a crash while
// checking the gate must not read as consent. So every failure after a rule
// matches is caught here and turned into a refusal, and cli.js never sees it.

import { currentBranch } from '../repo.js';
import * as gate from '../gate.js';
import { optionValue } from './command-parse.js';
import { select } from './rules.js';

/**
 * @typedef {object} Decision
 * @property {boolean} block
 * @property {string} [reason]   shown to the model when blocking
 * @property {string} [rule]     which rule fired
 * @property {string} [message]  shown when allowing
 */

/**
 * The branch a write would land on.
 *
 * Explicit beats implicit: `git push origin main` is a push to main even from a
 * feature branch, and gating it against the current branch would find a token
 * that was never meant for it.
 *
 * Commands with no branch of their own — `gh issue comment`, `gh api` — fall
 * back to the current branch. They are still gated, and the token is still
 * spent; what they cannot do is carry consent that was granted while standing
 * somewhere else.
 *
 * @param {import('./command-parse.js').ParsedCommand} command
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function targetBranch(command, cwd) {
  const head = optionValue(command, ['--head', '-H']);
  if (head) return head;

  if (command.program === 'git' && command.args[0] === 'push') {
    const positional = command.args.slice(1).filter((arg) => !arg.startsWith('-'));
    // `git push <remote> <refspec>`; the refspec may be `HEAD:branch`.
    const refspec = positional[1];
    if (refspec) return refspec.split(':').pop();
  }

  return currentBranch({ cwd });
}

/**
 * The pull request a review write would land on.
 *
 * `gh pr review 17577`, `gh pr comment 17577 --body …` — the number is the
 * first positional after the subcommand. A raw GraphQL mutation carries a
 * thread id and nothing else, so there is no number to find, and that case is
 * handled by the caller rather than guessed at here.
 *
 * @param {import('./command-parse.js').ParsedCommand} command
 * @returns {number|null}
 */
function targetPullRequest(command) {
  if (command.program !== 'gh' || command.args[0] !== 'pr') return null;

  const positional = command.args.slice(2).find((arg) => /^\d+$/.test(arg));
  return positional ? Number.parseInt(positional, 10) : null;
}

/**
 * @param {{rule: {id: string}, command: {raw: string}}} hit
 * @param {string} reason
 * @returns {Decision}
 */
function refuse(hit, reason) {
  return { block: true, rule: hit.rule.id, reason: `pdkit: ${reason}\n  command: ${hit.command.raw}` };
}

/**
 * Decide whether a Bash command may run.
 *
 * @param {{tool_name?: string, tool_input?: {command?: string}, cwd?: string}|null} payload
 * @param {{event: string, pluginRoot: string}} [_context]
 * @returns {Promise<Decision>}
 */
export async function handle(payload, _context) {
  if (payload?.tool_name && payload.tool_name !== 'Bash') return { block: false };

  const commandLine = payload?.tool_input?.command;
  if (!commandLine) return { block: false };

  const hit = select(commandLine);
  if (!hit) return { block: false };

  if (hit.rule.action === 'deny') return refuse(hit, hit.rule.reason);

  try {
    if ((hit.rule.gate ?? 'push') === 'reply') {
      const pr = targetPullRequest(hit.command);
      if (!pr) {
        // Failing closed with a remedy. A reply token is issued for one pull
        // request, and a command that never names one cannot be checked
        // against it — so this is refused rather than matched against whatever
        // token happens to be lying around.
        return refuse(
          hit,
          `${hit.rule.reason}\n  this command does not name a pull request, so the gate cannot tell which one it writes to` +
            `\n  use: pdkit pr reply --pr <number> --thread <id> --body <file>`,
        );
      }

      const checked = await gate.verify({ pr, kind: 'reply' });
      if (!checked.valid) return refuse(hit, `${hit.rule.reason}\n  ${checked.reason}`);

      // Not spent. The unit of consent for replies is the batch the human read
      // in one go (section 4), and spending on the first of eight would refuse
      // the seven they just approved. The TTL is what bounds it.
      return { block: false, rule: hit.rule.id, message: `pdkit: reply token for #${pr} accepted` };
    }

    const branch = await targetBranch(hit.command, payload?.cwd ?? process.cwd());
    if (!branch) {
      return refuse(hit, `${hit.rule.reason}\n  no branch to check: HEAD is detached or this is not a repository`);
    }

    const checked = await gate.verify({ branch, kind: 'push' });
    if (!checked.valid) return refuse(hit, `${hit.rule.reason}\n  ${checked.reason}`);

    // Spent on allow, not after the command returns: this hook does not get to
    // see whether the push succeeded, and a token left unspent by a failed
    // push would still be a second push nobody confirmed.
    const spent = await gate.close({ branch, kind: 'push' });
    if (!spent.ok) return refuse(hit, `${hit.rule.reason}\n  ${spent.error}`);

    return { block: false, rule: hit.rule.id, message: `pdkit: consent token for ${branch} spent` };
  } catch (error) {
    return refuse(hit, `the consent gate could not be checked (${error.message}), so this is refused`);
  }
}

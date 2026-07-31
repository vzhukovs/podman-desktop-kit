// SPDX-License-Identifier: Apache-2.0

// TaskCompleted handler: no receipt, no completion.
//
// "Done" means the output of the command from `Done when`, captured verbatim.
// Without this hook that rule is advice, and advice loses to a confident
// summary every time. With it, a task cannot be marked complete on narrative.
//
// Which task is being completed comes from lib/active.js, not from the event.
// The identifier in the payload is Claude Code's, and ours is T1 — mapping one
// to the other would be a guess, while the working tree already knows what it
// is executing. It is recorded in the journal so the two can be lined up later.
//
// The scope this implies, stated rather than discovered: while a task is marked
// active in a tree, *any* subagent completing there is asked for that task's
// receipt. During `/pd:exec` the only subagent running is the implementer, so
// that is the intent; outside it, `pdkit task stop` is what says the tree is no
// longer executing a planned task.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { current } from '../active.js';
import { issueDir, resolveHome } from '../config.js';
import { validateReceipt } from '../evidence.js';
import { append as appendJournal } from '../journal.js';

/**
 * @param {{task_id?: string, cwd?: string}|null} payload
 * @param {{event: string, pluginRoot: string}} [_context]
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, _context) {
  const active = await current({ cwd: payload?.cwd });
  if (!active) return { block: false };

  const home = resolveHome();
  const receiptPath = join(issueDir(home, active.issue), 'receipts', `${active.taskId}.md`);
  const capture = `pdkit receipt write --issue ${active.issue} --task ${active.taskId}`;

  /**
   * @param {string} problem
   * @returns {import('./dispatch.js').Decision}
   */
  const refuse = (problem) => ({
    block: true,
    rule: 'receipt',
    reason:
      `pdkit: ${active.taskId} of issue ${active.issue} cannot be completed — ${problem}.\n` +
      `  Run: ${capture}\n` +
      `  It runs the command from \`Done when\` itself and records what it printed. The output is not ` +
      `something you can hand it, which is the point: "the tests passed" and the test runner's own ` +
      `text are different kinds of claim.`,
  });

  let content;
  try {
    content = await readFile(receiptPath, 'utf8');
  } catch {
    return refuse('there is no receipt');
  }

  const checked = validateReceipt(content);
  if (!checked.ok) return refuse(checked.reason);

  // A genuine receipt for a run that failed. The receipt is valid — it is the
  // evidence that the task is not done — so what is refused here is the
  // completion, and the message says which of the two it is.
  if (checked.exitCode !== 0) {
    return {
      block: true,
      rule: 'receipt',
      reason:
        `pdkit: ${active.taskId} of issue ${active.issue} has a valid receipt for a command that failed ` +
        `(exit ${checked.exitCode === null ? 'none — killed' : checked.exitCode}).\n` +
        `  ${checked.command}\n` +
        `  ${receiptPath}\n` +
        `  Fix the work and capture again. If the command itself is wrong, that is a finding about the ` +
        `plan — report it rather than editing \`Done when\` to something that passes.`,
    };
  }

  await appendJournal(
    {
      issue: active.issue,
      event: 'task-receipt',
      detail: [`${active.taskId} accepted`, payload?.task_id ? `agent task ${payload.task_id}` : null]
        .filter(Boolean)
        .join('; '),
    },
    { home },
  );

  return { block: false, message: `pdkit: ${active.taskId} has a receipt for \`${checked.command}\`` };
}

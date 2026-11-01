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

// `pdkit receipt`: produce or check a receipt.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withdrawalFor, withdrawnMessage } from '../amendment.js';
import { parseTask } from '../artefacts.js';
import * as attempts from '../attempts.js';
import { paths, resolveHome } from '../config.js';
import * as evidence from '../evidence.js';
import * as git from '../git.js';
import * as state from '../state.js';
import { EXIT, describeRun, issueFlag, printJson, repoContext } from './support.js';

export const flags = ['issue', 'task'];

/**
 * Produce or check a receipt.
 *
 * `write` takes no output parameter, and that absence is the enforcement: the
 * command from `Done when` is run here, so "summarize the run convincingly" is
 * not a path that exists.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0];
  const issue = issueFlag(flags);
  const taskId = typeof flags.task === 'string' ? flags.task : args[1];

  if (!Number.isInteger(issue) || !taskId) {
    process.stderr.write(`pdkit receipt ${action ?? ''}: --issue and --task are required\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome();
  const receiptPath = join(paths(home).issues, String(issue), 'receipts', `${taskId}.md`);

  if (action === 'check') {
    let content;
    try {
      content = await readFile(receiptPath, 'utf8');
    } catch {
      process.stderr.write(`pdkit receipt check: ${taskId} of issue ${issue} has no receipt\n`);
      return EXIT.ERROR;
    }

    const checked = evidence.validateReceipt(content);
    if (flags.json) printJson({ path: receiptPath, ...checked });
    else process.stdout.write(checked.ok ? `${taskId}: a real capture of \`${checked.command}\`, exit ${checked.exitCode}\n` : `${taskId}: ${checked.reason}\n`);

    return checked.ok ? EXIT.OK : EXIT.ERROR;
  }

  if (action !== 'write') {
    process.stderr.write(`pdkit receipt: unknown action "${action ?? ''}" (write, check)\n`);
    return EXIT.ERROR;
  }

  const taskPath = join(paths(home).issues, String(issue), 'tasks', `${taskId}.md`);
  let task;
  try {
    task = parseTask(await readFile(taskPath, 'utf8'));
  } catch {
    process.stderr.write(`pdkit receipt write: ${taskPath} does not exist — the command to run comes from the task's \`Done when\`\n`);
    return EXIT.ERROR;
  }

  // A receipt for a withdrawn task is evidence for work the plan no longer
  // asks for, and the audit would have to explain it away.
  const withdrawn = await withdrawalFor(issue, taskId, home);
  if (withdrawn) {
    process.stderr.write(withdrawnMessage('receipt write', issue, taskId, withdrawn));
    return EXIT.ERROR;
  }

  if (!task.command) {
    process.stderr.write(
      `pdkit receipt write: ${taskId} has no executable \`Done when\`. Prose cannot be run, and a task ` +
        `whose completion cannot be demonstrated is a planning error — amend the plan rather than the receipt.\n`,
    );
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const cwd = repo.root ?? process.cwd();

  process.stdout.write(`$ ${task.command}\n`);
  const captured = await evidence.capture({ command: task.command, cwd });

  const written = await evidence.writeReceipt({
    issue,
    taskId,
    run: captured,
    commit: await headSha(cwd),
    files: task.owns,
  });

  process.stdout.write(describeRun({ path: written.path, run: captured, digest: written.digest }));

  // The attempt is counted from the same capture the receipt is made of. There
  // is no input for it, for the reason there is no input for the receipt text.
  if (captured.exitCode === 0) {
    await attempts.passed({ issue, taskId });
  } else {
    const state = await attempts.record({ issue, taskId, exitCode: captured.exitCode, config: repo.config });

    process.stdout.write(
      state.blocked
        ? `\n${attempts.blockedMessage({ issue }, state)}\n`
        : `  attempt ${state.attempts}${state.max > 0 ? ` of ${state.max}` : ''}\n`,
    );
  }

  // Non-zero is reported, not hidden: the receipt is valid either way, and the
  // caller needs to know which of the two it just produced.
  return captured.exitCode === 0 ? EXIT.OK : EXIT.ERROR;
}

/**
 * The commit a receipt was taken at, or null outside a repository.
 *
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function headSha(cwd) {
  try {
    const stdout = await git.text(['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

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

// `pdkit reset`: start one issue over.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { resolveHome } from '../config.js';
import * as reset from '../reset.js';
import { EXIT, printJson, repoContext } from './support.js';

export const flags = ['issue', 'confirm', 'purge', 'worktrees', 'force'];

/**
 * Start one issue over.
 *
 * Shaped like `close`: bare, it reports and changes nothing; `--confirm` is the
 * word that acts. That is not symmetry for its own sake — the two commands are
 * the only ones that stand at a boundary where the thing being decided is
 * whether a cycle is over, and both are read by somebody who wants to see the
 * consequences before agreeing to them.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit reset: an issue number is required\n');
    return EXIT.ERROR;
  }

  // Not fatal when there is no repository: three of the four stores live in
  // $PDKIT_HOME and can be cleared from anywhere. What is lost without one is
  // the worktree half, and that is said rather than assumed away.
  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });

  const facts = await reset.collect({ issue, repoRoot: repo.root, home });
  const purge = Boolean(flags.purge);
  const trees = Boolean(flags.worktrees);

  if (!flags.confirm) {
    if (flags.json) printJson({ ...facts, confirmed: false });
    else {
      process.stdout.write(reset.format(facts, { purge, worktrees: trees }));
      if (facts.anything) {
        process.stdout.write(
          `\n  Nothing has been done. To go ahead:\n` +
            `    pdkit reset ${issue} --confirm${purge ? ' --purge' : ''}${trees ? ' --worktrees' : ''}\n`,
        );
      }
      if (!repo.root) {
        process.stdout.write('  (no repository here, so worktrees were not looked at — run this from the fork to see them)\n');
      }
    }
    return EXIT.OK;
  }

  if (!facts.anything) {
    process.stdout.write(`DESKTOP-${issue}: nothing to clear\n`);
    return EXIT.OK;
  }

  if (trees && !repo.root) {
    process.stderr.write(`pdkit reset: --worktrees needs a repository — ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const outcome = await reset.apply({
    issue,
    facts,
    repoRoot: repo.root,
    config: repo.config,
    home,
    purge,
    worktrees: trees,
    force: Boolean(flags.force),
  });

  if (flags.json) {
    printJson(outcome);
    return EXIT.OK;
  }

  process.stdout.write(
    `DESKTOP-${issue} was ${outcome.from}, and the plugin no longer has a record of it\n` +
      (outcome.removed
        ? outcome.archived
          ? `  archived    : ${outcome.archived}\n` + `                nothing reads it; \`mv\` it back over the issue directory to undo this\n`
          : '  purged      : the artefacts are gone\n'
        : '') +
      (outcome.tokens.length ? `  revoked     : ${outcome.tokens.join(', ')}\n` : '') +
      (outcome.active.length ? `  cleared     : ${outcome.active.join(', ')}\n` : ''),
  );

  for (const tree of outcome.worktrees) {
    process.stdout.write(`  ${tree.removed ? 'removed' : 'kept'}     : ${tree.path}${tree.removed ? '' : ` — ${tree.error}`}\n`);
  }
  // Reported after acting as well as before it. The dry run is the place this
  // is meant to be read, and the dry run is the step people skip.
  for (const tree of facts.worktrees.filter(() => !flags.worktrees)) {
    process.stdout.write(`  kept        : ${tree.path}${tree.branch ? ` (${tree.branch})` : ' (detached)'} — --worktrees removes it\n`);
  }
  if (facts.openPullRequests.length) {
    process.stdout.write(
      `  still open  : ${facts.openPullRequests.map((number) => `#${number}`).join(', ')} — upstream, and untouched by this\n`,
    );
  }

  process.stdout.write(
    `\n  The machine reads DESKTOP-${issue} as \`new\`, whose only exit is \`triaged\`:\n` +
      `    /pd:triage ${issue}\n` +
      `  The journal kept ${facts.journalEntries} entr${facts.journalEntries === 1 ? 'y' : 'ies'} from before this — \`pdkit journal --issue ${issue}\`.\n`,
  );

  return EXIT.OK;
}

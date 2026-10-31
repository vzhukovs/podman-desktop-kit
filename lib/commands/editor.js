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

// `pdkit editor`: open an issue's worktree in the configured IDE.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { trustedValue } from '../config.js';
import { exampleFor, openInEditor } from '../editor.js';
import { EXIT, issueMeant, repoContext, reportOpened, treeOf, trustedHome } from './support.js';

export const flags = ['issue'];

/**
 * Open an issue's worktree in the configured IDE.
 *
 * `editor.path` is read through `trustedValue`: $PDKIT_HOME/config.yaml and the
 * defaults only, and a repository that sets it is refused rather than ignored.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const repo = await repoContext(flags);

  const fail = (message) => {
    process.stderr.write(`pdkit editor: ${message}\n`);
    return EXIT.ERROR;
  };

  const meant = await issueMeant(args[0] ?? flags.issue, repo);
  if (meant.error) return fail(meant.error);

  const trusted = trustedHome(repo);
  if (trusted.error) return fail(trusted.error);

  const read = trustedValue('editor.path', { repoRoot: repo.root });
  if (read.error) return fail(read.error);
  const { configFile } = read;

  const tree = await treeOf(meant.issue, repo);
  if (tree.error) return fail(tree.error);

  const editorPath = read.value;
  const result = await openInEditor(tree.path, { editorPath: typeof editorPath === 'string' ? editorPath : undefined });
  if (!result.unconfigured) return reportOpened('editor', tree.path, result, flags);

  // The one failure with a fix that fits on the screen, so the fix is printed
  // rather than described: the file to edit and the lines to put in it, for
  // the platform the person is on.
  const example = exampleFor();
  if (flags.json) return reportOpened('editor', tree.path, { ...result, configFile, example }, flags);

  return reportOpened(
    'editor',
    tree.path,
    { ...result, reason: 'warning: editor.path is not configured, so there is no IDE to open it in' },
    flags,
    `  Set it in ${configFile}:\n\n${example}\n`,
  );
}

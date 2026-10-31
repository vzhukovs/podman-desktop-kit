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

// `pdkit render`: fill a shipped template and write it under the issue.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';

import { resolveHome } from '../config.js';
import * as render from '../render.js';
import { EXIT, issueFlag, printJson, repoContext } from './support.js';

export const flags = ['check', 'file', 'issue', 'values', 'path', 'strip-comments'];

/**
 * Fill a shipped template and write it under the issue.
 *
 * Values come from a file rather than the command line: a plan's context
 * section is paragraphs, and paragraphs in argv is how quoting bugs get into
 * artefacts nobody re-reads.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const template = args[0];

  // `render --check` reads an artefact back instead of writing one. It lives on
  // this command rather than its own because it answers a question about a
  // template, and the templates are what this command owns.
  if (flags.check) {
    const name = typeof flags.check === 'string' ? flags.check : template;
    const file = typeof flags.file === 'string' ? flags.file : args[1];

    if (!name || !file) {
      process.stderr.write('pdkit render --check <template> --file <path>\n');
      return EXIT.ERROR;
    }

    const result = await render.validateSections(name, await readFile(file, 'utf8'));
    if (flags.json) printJson({ template: name, file, ...result });
    else if (result.ok) process.stdout.write(`${file}: every section ${name} declares is present\n`);
    else process.stdout.write(`${file} is missing:\n${result.missing.map((section) => `  ${section}\n`).join('')}`);

    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  const issue = issueFlag(flags);

  if (!template || !Number.isInteger(issue) || typeof flags.values !== 'string') {
    process.stderr.write(
      'pdkit render: usage: pdkit render <template> --issue <n> --values <file.json> [--path <p>]\n' +
        `  templates: ${Object.keys(render.TEMPLATES).join(', ')}\n`,
    );
    return EXIT.ERROR;
  }

  let values;
  try {
    values = JSON.parse(await readFile(flags.values, 'utf8'));
  } catch (error) {
    process.stderr.write(`pdkit render: cannot read ${flags.values} (${error.message})\n`);
    return EXIT.ERROR;
  }

  const stripComments = Boolean(flags['strip-comments']);

  // Passed so the implicit values a template asks for are resolved against the
  // repository being worked on rather than against whatever the shell happens
  // to be standing in — the attribution footer reads the fork slug from there.
  const repo = await repoContext(flags);
  const repoRoot = repo.root ?? undefined;
  const home = resolveHome({ repoRoot });

  // No --path means print it. Rendering a PR body to look at it before
  // anything is written is the common case.
  if (typeof flags.path !== 'string') {
    process.stdout.write(await render.render(template, values, { stripComments, repoRoot, home }));
    return EXIT.OK;
  }

  const written = await render.write({ issue, template, path: flags.path, values, stripComments, repoRoot, home });
  process.stdout.write(`${written}\n`);
  return EXIT.OK;
}

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

// Opening an issue's working tree in the person's IDE.
//
// The same split as lib/reveal.js, for the same reason: which command runs is a
// pure function of the configured path and the platform, because two of the
// three platforms cannot be exercised from the third. Starting it is reveal's
// `launch`, detached, unref'd, from the home directory and without a shell.
//
// What differs from reveal is who decides that nothing opening is a failure.
// `pdkit editor` has no other job, so this module reports and the CLI turns a
// window that did not appear into the exit code.
//
// There is no default IDE. Guessing one means guessing what is installed, and a
// guess that opens VS Code for somebody who works in WebStorm is worse than a
// warning that says which key to set.
//
// `editor.path` names a program pdkit will run, so it is held to more than a
// path is. Absolute only: a bare `code` is searched for in the working
// directory first on Windows, and the working directory is a repository. An
// .exe only on Windows: a .cmd runs through cmd.exe, which expands %VAR% and
// re-parses quotes in ways no escaping survives (CVE-2024-27980). Not writable
// by every user, since then anyone on the machine chooses what runs. And never
// from a repository's .pdkit.yaml — that is the CLI's half, see runEditor.

import { realpath, stat } from 'node:fs/promises';
import { platform } from 'node:os';

import { expandTilde } from './config.js';
import { hasDesktop, launch, pathProblem, safeDirectory } from './reveal.js';

/**
 * The command that opens `dir` in the IDE at `editorPath`.
 *
 * A macOS `.app` is a directory, not something to execute: `open -a` hands it
 * the folder, and reuses the instance that is already running — `-n` would
 * start a second WebStorm with a second index. Everything else — a JetBrains
 * or VS Code .exe, `webstorm.sh`, a Toolbox script — takes the directory as its
 * only argument.
 *
 * Both paths must already be checked: `editorPathProblem` and `safeDirectory`.
 *
 * @param {string} editorPath
 * @param {string} dir
 * @param {string} [os] defaults to the host
 * @returns {{command: string, args: string[]}}
 */
export function editorCommand(editorPath, dir, os = platform()) {
  if (os === 'darwin' && /\.app\/?$/i.test(editorPath)) {
    return { command: '/usr/bin/open', args: ['-a', editorPath.replace(/\/$/, ''), dir] };
  }
  return { command: editorPath, args: [dir] };
}

/**
 * Why a configured value cannot be run, or null. The checks that need no disk.
 *
 * @param {string} editorPath tilde already expanded
 * @param {string} [os] defaults to the host
 * @returns {string|null}
 */
export function editorPathProblem(editorPath, os = platform()) {
  const problem = pathProblem(editorPath, os);
  if (problem) return `editor.path ${editorPath} ${problem} — set the full path to the IDE`;

  if (os === 'win32' && /\.(cmd|bat)$/i.test(editorPath)) {
    return `editor.path ${editorPath} is a batch file, which only runs through cmd.exe — point it at the IDE's .exe (VS Code: ...\\Microsoft VS Code\\Code.exe)`;
  }
  if (os === 'win32' && !/\.exe$/i.test(editorPath)) return `editor.path ${editorPath} is not an .exe`;

  return null;
}

/**
 * What to put in the config, for the platform the person is on.
 *
 * Single quotes on Windows: lib/yaml.js reads a backslash inside double quotes
 * as an escape, and `\b` in `\bin\` is exactly the kind of path that would come
 * back as something else.
 *
 * @param {string} [os] defaults to the host
 * @returns {string} a YAML fragment, indented for a terminal
 */
export function exampleFor(os = platform()) {
  const lines = {
    darwin: ['    path: /Applications/WebStorm.app', '    # or: /Applications/Visual Studio Code.app'],
    win32: [
      "    path: 'C:\\Program Files\\JetBrains\\WebStorm 2026.2\\bin\\webstorm64.exe'",
      "    # or: 'C:\\Users\\<you>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'",
    ],
    linux: ['    path: ~/.local/share/JetBrains/Toolbox/scripts/webstorm', '    # or: /usr/share/code/code'],
  }[os] ?? ['    path: /absolute/path/to/your/ide'];

  return ['  editor:', ...lines].join('\n');
}

/**
 * The configured IDE, canonical and checked on disk.
 *
 * @param {string} editorPath tilde already expanded
 * @param {string} os
 * @returns {Promise<{ok: true, path: string}|{ok: false, reason: string}>}
 */
async function checkedEditor(editorPath, os) {
  const problem = editorPathProblem(editorPath, os);
  if (problem) return { ok: false, reason: problem };

  let real;
  let info;
  try {
    real = await realpath(editorPath);
    info = await stat(real);
  } catch {
    return { ok: false, reason: `editor.path points at ${editorPath}, which does not exist` };
  }

  const bundle = os === 'darwin' && /\.app$/i.test(real);
  if (bundle ? !info.isDirectory() : !info.isFile()) {
    return { ok: false, reason: `editor.path ${real} is not ${bundle ? 'an application bundle' : 'a program'}` };
  }

  // Windows has no mode bits to read; its ACLs are out of reach without a shell.
  if (os !== 'win32' && (info.mode & 0o002) !== 0) {
    return { ok: false, reason: `editor.path ${real} is writable by every user on this machine, so any of them chooses what runs` };
  }

  return { ok: true, path: real };
}

/**
 * Open a directory in the configured IDE.
 *
 * Never throws: every way of not opening comes back as a reason, and
 * `unconfigured` separates the one the person fixes in config from the ones
 * they fix elsewhere.
 *
 * @param {string} dir
 * @param {{editorPath: string|undefined, os?: string, env?: Record<string, string|undefined>, spawn?: Function}} options
 *   editorPath from a layer the person wrote, never from a repository
 * @returns {Promise<{opened: boolean, unconfigured?: boolean, reason?: string, command?: string}>}
 */
export async function openInEditor(dir, options) {
  const os = options.os ?? platform();
  const env = options.env ?? process.env;

  const configured = String(options.editorPath ?? '').trim();
  if (!configured) return { opened: false, unconfigured: true, reason: 'editor.path is not configured' };

  const editor = await checkedEditor(expandTilde(configured), os);
  if (!editor.ok) return { opened: false, reason: editor.reason };

  const target = await safeDirectory(dir, os);
  if (!target.ok) return { opened: false, reason: target.reason };

  if (!hasDesktop(env, os)) return { opened: false, reason: 'no DISPLAY or WAYLAND_DISPLAY' };

  return launch(editorCommand(editor.path, target.path, os), options.spawn, env);
}

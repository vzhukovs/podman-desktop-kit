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

// Showing a written artefact to the person who has to read it.
//
// The plugin writes files outside the repository, under $PDKIT_HOME, which is
// exactly where nobody has a window open. Printing the path is correct and
// still leaves a copy-paste between finishing a review and reading it.
//
// Two rules shape this module, and both are about staying harmless.
//
// Deciding WHICH command to run is a pure function, separate from running it.
// Two of the three platforms cannot be exercised from the third, so the part
// that differs between them has to be checkable without a desktop — the same
// split as displayProblem in lib/validation.js.
//
// And failing to open a file manager is never an error. The artefact is on
// disk, its path has been printed, and the work is done; a command that
// reported failure because a GUI did not appear would be reporting on
// something it was not asked to do.
//
// Opening is also a way of running code, and the checks below exist because of
// it. On macOS `open` on a directory that is an application bundle LAUNCHES it
// — so does `open -a Finder` — and on Windows a bare `explorer.exe` is looked
// up in the working directory before PATH. Both were reachable: a repository's
// .pdkit.yaml can move state.root, and a pull request under review decides
// what its tree contains. So a directory is canonicalised and refused if it is
// a bundle, every platform tool is started by absolute path, and nothing is
// started from the caller's working directory.

import { spawn } from 'node:child_process';
import { accessSync, constants as FS } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, posix, win32 } from 'node:path';

/**
 * Directory names macOS treats as a bundle. Opening one runs it or hands it to
 * whatever claims it, never shows it.
 */
const BUNDLE = /\.(app|appex|bundle|framework|plugin|kext|prefpane|xpc|workflow|action|saver|qlgenerator|mdimporter|service)$/i;

/**
 * A value made safe to print where a person or a model reads it.
 *
 * Paths and branch names are written by whoever made the directory or pushed
 * the branch, which for a reviewed pull request is somebody else. Control
 * characters could rewrite the terminal, bidi overrides could make a line read
 * as something it is not, and length is capped so a name cannot carry a page
 * of instructions into the session that reads it.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function printable(value, max = 300) {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Why a path cannot be handed to a platform tool, or null.
 *
 * Absolute, so it is never resolved against a working directory and never
 * starts with `-`, where a tool would read it as an option. On Windows it also
 * needs a drive letter: `\\host\share` makes Explorer authenticate to that host,
 * which hands it the user's NTLM hash, and `\dir` is relative to a drive nobody
 * chose.
 *
 * @param {string} path
 * @param {string} [os] defaults to the host
 * @returns {string|null}
 */
export function pathProblem(path, os = platform()) {
  if (os === 'win32') {
    if (/^[\\/]{2}/.test(path)) return 'is a network path — opening it would authenticate to that host';
    if (!/^[a-z]:[\\/]/i.test(path)) return 'is not an absolute path with a drive letter';
    return null;
  }
  if (!posix.isAbsolute(path)) return 'is not an absolute path';
  return null;
}

/**
 * Why a configured program cannot be run, or null. The checks that need no disk.
 *
 * Absolute, for the reason `pathProblem` gives and one more: a bare name on
 * Windows is searched for in the working directory first, and the working
 * directory is a repository. On Windows an .exe only: a .cmd or .bat runs
 * through cmd.exe, which expands %VAR% and re-parses quotes in ways no escaping
 * survives (CVE-2024-27980).
 *
 * @param {string} program tilde already expanded
 * @param {string} label the key or variable it came from, for the message
 * @param {string} [os] defaults to the host
 * @returns {string|null}
 */
export function programProblem(program, label, os = platform()) {
  const problem = pathProblem(program, os);
  if (problem) return `${label} ${program} ${problem} — set the full path to the program`;

  if (os === 'win32' && /\.(cmd|bat)$/i.test(program)) {
    return `${label} ${program} is a batch file, which only runs through cmd.exe — point it at the .exe`;
  }
  if (os === 'win32' && !/\.exe$/i.test(program)) return `${label} ${program} is not an .exe`;

  return null;
}

/**
 * A configured program, canonical and checked on disk.
 *
 * Not writable by every user, since then anyone on the machine chooses what
 * runs. Windows has no mode bits to read, and its ACLs are out of reach without
 * a shell, so there that check is the one that cannot be made.
 *
 * @param {string} program tilde already expanded
 * @param {{label: string, os?: string, bundle?: boolean}} options  bundle: a
 *   macOS `.app` directory is accepted, for a program `open -a` starts
 * @returns {Promise<{ok: true, path: string}|{ok: false, reason: string}>}
 */
export async function checkedProgram(program, options) {
  const os = options.os ?? platform();
  const problem = programProblem(program, options.label, os);
  if (problem) return { ok: false, reason: problem };

  let real;
  let info;
  try {
    real = await realpath(program);
    info = await stat(real);
  } catch {
    return { ok: false, reason: `${options.label} points at ${program}, which does not exist` };
  }

  const bundle = Boolean(options.bundle) && os === 'darwin' && /\.app$/i.test(real);
  if (bundle ? !info.isDirectory() : !info.isFile()) {
    return { ok: false, reason: `${options.label} ${real} is not ${bundle ? 'an application bundle' : 'a program'}` };
  }

  if (os !== 'win32' && (info.mode & 0o002) !== 0) {
    return { ok: false, reason: `${options.label} ${real} is writable by every user on this machine, so any of them chooses what runs` };
  }

  return { ok: true, path: real };
}

/**
 * A directory that is safe to open: canonical, really a directory, and not
 * something the platform would run instead of showing.
 *
 * @param {string} dir
 * @param {string} [os] defaults to the host
 * @returns {Promise<{ok: true, path: string}|{ok: false, reason: string}>}
 */
export async function safeDirectory(dir, os = platform()) {
  const problem = pathProblem(dir, os);
  if (problem) return { ok: false, reason: `${dir} ${problem}` };

  let real;
  try {
    real = await realpath(dir);
    if (!(await stat(real)).isDirectory()) return { ok: false, reason: `${real} is not a directory` };
  } catch {
    return { ok: false, reason: `${dir} does not exist` };
  }

  if (os === 'darwin' && (BUNDLE.test(basename(real)) || canRead(join(real, 'Contents', 'Info.plist')))) {
    return { ok: false, reason: `${real} is an application bundle — opening it would run it` };
  }

  // `name.{CLSID}` makes a folder a shell-namespace junction, which Explorer
  // opens with whatever COM object the CLSID names.
  if (os === 'win32' && /\.\{[0-9a-f-]{36}\}$/i.test(basename(real))) {
    return { ok: false, reason: `${real} is a shell-namespace junction` };
  }

  return { ok: true, path: real };
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function canRead(path) {
  try {
    accessSync(path, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explorer by absolute path. A bare `explorer.exe` is searched for in the
 * working directory first, which is the repository.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function explorer(env) {
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'explorer.exe');
}

/**
 * The command that shows a path in the platform's file manager, or null when
 * there is no convention to follow.
 *
 * Windows and macOS can select the file itself; Linux cannot, portably. Every
 * desktop there has its own flag — `nautilus --select`, `dolphin --select`,
 * `nemo` — and picking one means guessing which is installed, so the directory
 * is opened instead. Less precise, and it works everywhere `xdg-open` does.
 *
 * @param {string} target absolute path to the file
 * @param {string} [os] defaults to the host; a parameter so all three are testable from any one
 * @param {Record<string, string|undefined>} [env]
 * @returns {{command: string, args: string[], selects: boolean}|null}
 */
export function revealCommand(target, os = platform(), env = process.env) {
  if (os === 'darwin') return { command: '/usr/bin/open', args: ['-R', target], selects: true };

  // No space after the comma, and the path is part of the same argument:
  // `explorer /select,C:\path\file.md`. Split into two arguments it opens the
  // user's Documents folder instead, which is the kind of wrong that looks
  // like it worked.
  if (os === 'win32') return { command: explorer(env), args: [`/select,${target}`], selects: true };

  if (os === 'linux') return { command: 'xdg-open', args: [dirname(target)], selects: false };

  return null;
}

/**
 * Whether a desktop is there to open anything in.
 *
 * Only Linux answers this, and only in one direction — the same asymmetry, and
 * the same reasoning, as `displayProblem`. On a headless Linux box `xdg-open`
 * either fails or, worse, blocks; skipping is the honest outcome.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} os
 * @returns {boolean}
 */
export function hasDesktop(env, os) {
  if (os !== 'linux') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * The command that opens a directory in the platform's file manager, or null
 * when there is no convention to follow.
 *
 * Unlike `revealCommand` all three platforms agree here: a directory has
 * nothing to select, so every one of them is told to open it. Only call it
 * with what `safeDirectory` returned: on macOS this same command runs a bundle.
 *
 * @param {string} dir absolute path to the directory
 * @param {string} [os] defaults to the host
 * @param {Record<string, string|undefined>} [env]
 * @returns {{command: string, args: string[]}|null}
 */
export function openDirCommand(dir, os = platform(), env = process.env) {
  if (os === 'darwin') return { command: '/usr/bin/open', args: [dir] };
  if (os === 'win32') return { command: explorer(env), args: [dir] };
  if (os === 'linux') return { command: 'xdg-open', args: [dir] };
  return null;
}

/**
 * A bare command name resolved against the ABSOLUTE entries of PATH only.
 *
 * An empty entry or `.` in PATH means the working directory, and the working
 * directory is the repository. xdg-open has no fixed location to name instead.
 *
 * @param {string} name
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function onPath(name, env) {
  for (const entry of String(env.PATH ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, FS.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Start a chosen command detached, and report whether it started.
 *
 * Detached and unref'd: the file manager outlives pdkit, and a CLI that waited
 * for a window to close would hang the command that opened it. stdio is
 * discarded because `xdg-open` in particular writes to stderr on desktops it
 * only half understands, and that noise would land in the middle of output
 * somebody is reading. Started from the home directory, never from wherever
 * pdkit was called, and never through a shell.
 *
 * Exported for lib/editor.js, which starts an IDE the same way and for the same
 * reasons.
 *
 * @param {{command: string, args: string[], options?: object}} chosen  options are
 *   merged into spawn's, for a command that needs more than the defaults
 * @param {Function} [run] defaults to child_process.spawn
 * @param {Record<string, string|undefined>} [env] where a bare command is looked up
 * @returns {Promise<{opened: boolean, reason?: string, command?: string}>}
 */
export async function launch(chosen, run = spawn, env = process.env) {
  const command = isAbsolute(chosen.command) ? chosen.command : onPath(chosen.command, env);
  if (!command) return { opened: false, reason: `${chosen.command}: not found on PATH` };

  try {
    const child = run(command, chosen.args, { detached: true, stdio: 'ignore', cwd: homedir(), ...chosen.options, shell: false });

    return await new Promise((done) => {
      // Resolved from whichever comes first. A file manager that is already
      // running often exits immediately after handing the request over, and on
      // Windows `explorer.exe` exits non-zero even when it worked — so the exit
      // code is not consulted at all. What is being reported is that the
      // command started, which is the only part this module can know.
      child.once?.('spawn', () => {
        child.unref?.();
        done({ opened: true, command: `${command} ${chosen.args.join(' ')}` });
      });
      child.once?.('error', (error) => done({ opened: false, reason: `${command}: ${error.message}` }));
    });
  } catch (error) {
    return { opened: false, reason: `${command}: ${error.message}` };
  }
}

/**
 * Show a file in the platform's file manager.
 *
 * Never throws, and never reports failure as an error: see the header.
 *
 * @param {string} target
 * @param {{os?: string, env?: Record<string, string|undefined>, spawn?: Function}} [options]
 * @returns {Promise<{opened: boolean, reason?: string, command?: string}>}
 */
export async function reveal(target, options = {}) {
  const os = options.os ?? platform();
  const env = options.env ?? process.env;

  const chosen = revealCommand(target, os, env);
  if (!chosen) return { opened: false, reason: `no file manager convention for ${os}` };
  const problem = pathProblem(target, os);
  if (problem) return { opened: false, reason: `${target} ${problem}` };
  if (!hasDesktop(env, os)) return { opened: false, reason: 'no DISPLAY or WAYLAND_DISPLAY' };

  return launch(chosen, options.spawn, env);
}

/**
 * Open a directory in the platform's file manager.
 *
 * Never throws. Whether a window that did not appear is an error is the
 * caller's call, not this module's: for `review render --reveal` it is a note,
 * for `pdkit open` — whose only job it is — it is the exit code.
 *
 * @param {string} dir
 * @param {{os?: string, env?: Record<string, string|undefined>, spawn?: Function}} [options]
 * @returns {Promise<{opened: boolean, reason?: string, command?: string, path?: string}>}
 */
export async function openDir(dir, options = {}) {
  const os = options.os ?? platform();
  const env = options.env ?? process.env;

  if (!openDirCommand(dir, os, env)) return { opened: false, reason: `no file manager convention for ${os}` };

  const safe = await safeDirectory(dir, os);
  if (!safe.ok) return { opened: false, reason: safe.reason };
  if (!hasDesktop(env, os)) return { opened: false, reason: 'no DISPLAY or WAYLAND_DISPLAY' };

  return { ...(await launch(openDirCommand(safe.path, os, env), options.spawn, env)), path: safe.path };
}

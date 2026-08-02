// SPDX-License-Identifier: Apache-2.0

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

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { dirname } from 'node:path';

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
 * @returns {{command: string, args: string[], selects: boolean}|null}
 */
export function revealCommand(target, os = platform()) {
  if (os === 'darwin') return { command: 'open', args: ['-R', target], selects: true };

  // No space after the comma, and the path is part of the same argument:
  // `explorer /select,C:\path\file.md`. Split into two arguments it opens the
  // user's Documents folder instead, which is the kind of wrong that looks
  // like it worked.
  if (os === 'win32') return { command: 'explorer.exe', args: [`/select,${target}`], selects: true };

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
function hasDesktop(env, os) {
  if (os !== 'linux') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Show a file in the platform's file manager.
 *
 * Detached and unref'd: the file manager outlives pdkit, and a CLI that waited
 * for a window to close would hang the command that opened it. stdio is
 * discarded because `xdg-open` in particular writes to stderr on desktops it
 * only half understands, and that noise would land in the middle of output
 * somebody is reading.
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

  const chosen = revealCommand(target, os);
  if (!chosen) return { opened: false, reason: `no file manager convention for ${os}` };
  if (!hasDesktop(env, os)) return { opened: false, reason: 'no DISPLAY or WAYLAND_DISPLAY' };

  const run = options.spawn ?? spawn;

  try {
    const child = run(chosen.command, chosen.args, { detached: true, stdio: 'ignore' });

    return await new Promise((done) => {
      // Resolved from whichever comes first. A file manager that is already
      // running often exits immediately after handing the request over, and on
      // Windows `explorer.exe` exits non-zero even when it worked — so the exit
      // code is not consulted at all. What is being reported is that the
      // command started, which is the only part this module can know.
      child.once?.('spawn', () => {
        child.unref?.();
        done({ opened: true, command: `${chosen.command} ${chosen.args.join(' ')}` });
      });
      child.once?.('error', (error) => done({ opened: false, reason: `${chosen.command}: ${error.message}` }));
    });
  } catch (error) {
    return { opened: false, reason: `${chosen.command}: ${error.message}` };
  }
}

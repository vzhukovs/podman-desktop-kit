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

// Validation as an entity (spec section 2.2, invariant 5) — the part that runs
// the application: starting the built podman-desktop under CDP, waiting for the
// endpoint, and stopping it again.
//
// Reading and saving the record arrive as parameters (Records below): they live
// in lib/validation.js, which re-exports this file and stays the one writer of
// the record, and importing them back would be a cycle.

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';

import { expandTilde, get, resolveHome, trustedValue } from '../config.js';
import { parseDuration } from '../duration.js';
import { append as appendJournal } from '../journal.js';
import { checkedProgram } from '../reveal.js';

/** @typedef {import('../validation.js').Record_} Record_ */

/**
 * What launching and stopping need from lib/validation.js, handed over by its
 * facade.
 *
 * `save` is among them on purpose: the record keeps one writer, and a launch
 * stores the application it started through it rather than through a second one.
 *
 * @typedef {object} Records
 * @property {(issue: number, options?: {home?: string}) => Promise<Record_|null>} read
 * @property {(issue: number) => Record_} blank
 * @property {(record: Record_, options: {home?: string}) => Promise<Record_>} save
 */

/** Where CDP announces itself. Upstream's own runner waits on exactly this. */
const READY_PATH = '/json/version';

/** Default port, matching Chromium's conventional one. */
const DEFAULT_PORT = 9222;

/** How long to wait for the window to come up before giving up. */
const DEFAULT_STARTUP_MS = 60_000;

/** How often to ask. Connection errors are expected while the app boots. */
const PROBE_INTERVAL_MS = 500;

/**
 * How long one probe may take. Generous against a busy machine, short against
 * `startup_timeout` — a single probe must never be able to outlive the budget
 * for the whole launch.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * `validation.app.binary` and `validation.app.args`, read only from layers the
 * person wrote.
 *
 * Validation runs the tree's own code by design — `electron .` is its main
 * process — so a repository that chose the binary would gain less here than it
 * would choosing editor.path. Not nothing: the binary can live anywhere, and
 * the arguments are Electron's, where `--remote-debugging-address=0.0.0.0`
 * hands the debug port to the whole network. So the same rule holds, through
 * the same `trustedValue`.
 *
 * @param {string|null} repoRoot
 * @returns {{binary?: unknown, args?: unknown, error?: string}}
 */
export function trustedApp(repoRoot) {
  const binary = trustedValue('validation.app.binary', { repoRoot });
  if ('error' in binary) return { error: binary.error };
  const args = trustedValue('validation.app.args', { repoRoot });
  if ('error' in args) return { error: args.error };
  return { binary: binary.value, args: args.value };
}

/**
 * Which binary to drive, and with what arguments.
 *
 * Three sources, most explicit first. The last one is why `pnpm compile` is not
 * required: `node_modules/.bin/electron .` runs the development build, which is
 * what `pnpm build` produces and what upstream's own e2e uses when
 * PODMAN_DESKTOP_BINARY is unset. Packaging costs minutes and proves nothing
 * extra for validation.
 *
 * The first two name a program from outside the tree, so they are held to
 * `checkedProgram`: absolute, an .exe on Windows, not writable by every user.
 * The launch runs from the working tree, and a bare name there would be looked
 * up in it first on Windows.
 *
 * @param {{repoRoot: string, app?: {binary?: unknown, args?: unknown}, env?: Record<string, string|undefined>}} input
 *   app from `trustedApp`, never from the merged config
 * @returns {Promise<{ok: boolean, command?: string, args?: string[], source?: string, error?: string}>}
 */
export async function resolveBinary(input) {
  const env = input.env ?? process.env;

  const configured = String(input.app?.binary ?? '').trim();
  if (configured) {
    const checked = await checkedProgram(expandTilde(configured), { label: 'validation.app.binary' });
    if (!checked.ok) return { ok: false, error: checked.reason };

    // `validation.app.args` exists because a packaged application is not always
    // launchable by path alone, and because splitting the binary on spaces
    // would be unusable on Windows, where paths contain them as a matter of
    // course. A list, so nothing has to be quoted.
    const extra = input.app?.args;
    return { ok: true, command: checked.path, args: Array.isArray(extra) ? extra.map(String) : [], source: 'validation.app.binary' };
  }

  const fromEnv = String(env.PODMAN_DESKTOP_BINARY ?? '').trim();
  if (fromEnv) {
    const checked = await checkedProgram(expandTilde(fromEnv), { label: 'PODMAN_DESKTOP_BINARY' });
    if (!checked.ok) return { ok: false, error: checked.reason };
    return { ok: true, command: checked.path, args: [], source: 'PODMAN_DESKTOP_BINARY' };
  }

  // The real executable before the shim, and on Windows that distinction is the
  // difference between launching and not. `node_modules/.bin/electron` is a
  // shell script there — spawning it without a shell fails, and spawning it
  // WITH one puts cmd.exe between us and the application, so `stop` would kill
  // the shell and leave the app holding the debug port.
  const candidates =
    platform() === 'win32'
      ? [
          { path: join(input.repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), args: ['.'], source: 'node_modules/electron/dist/electron.exe' },
          { path: join(input.repoRoot, 'node_modules', '.bin', 'electron.cmd'), args: ['.'], source: 'node_modules/.bin/electron.cmd' },
        ]
      : [{ path: join(input.repoRoot, 'node_modules', '.bin', 'electron'), args: ['.'], source: 'node_modules/.bin/electron' }];

  for (const candidate of candidates) {
    try {
      // Windows has no execute bit, so X_OK there is really "does it exist".
      await access(candidate.path, platform() === 'win32' ? constants.F_OK : constants.X_OK);
      return { ok: true, command: candidate.path, args: candidate.args, source: candidate.source };
    } catch {
      // Next candidate.
    }
  }

  return {
    ok: false,
    error:
      'no application to drive: validation.app.binary is empty, PODMAN_DESKTOP_BINARY is unset, and ' +
      `${candidates.map((candidate) => candidate.source).join(' or ')} is not in this working tree. Install ` +
      'dependencies and build the application, or point validation.app.binary at a packaged one',
  };
}

/**
 * Ask the CDP endpoint whether it is up.
 *
 * @param {number} port
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>}
 */
async function probePort(port, options = {}) {
  // Bounded, and that is the point. `fetch` has no timeout of its own, and
  // "up" is not the only alternative to "refused": an Electron that is dying,
  // or has lost its window, accepts the connection and then answers nothing.
  // Found by leaving one behind — `validate launch` hung with no output for as
  // long as it was allowed to, past its own startup_timeout, because the guard
  // for that lives inside the polling loop and the first probe never returned
  // to reach it.
  const bound = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, bound]) : bound;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${READY_PATH}`, { signal });
    return response.ok ? 'ready' : 'occupied';
  } catch (error) {
    // Three outcomes, not two, because the two failures need different advice.
    // Refused means nothing is there and the port is ours to use. A probe that
    // ran out of time means something holds the port and will not answer, and
    // spawning into that produces an application that cannot bind, sixty
    // seconds of waiting, and a timeout that blames the build.
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'occupied' : 'absent';
  }
}

/**
 * Whether the endpoint is up and answering.
 *
 * @param {number} port
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>}
 */
async function ready(port, options = {}) {
  return (await probePort(port, options)) === 'ready';
}

/**
 * Whether a process is still running, without disturbing it.
 *
 * `EPERM` counts as alive and that is the whole subtlety: a process owned by
 * somebody else cannot be signalled, and reading that as "gone" would clear the
 * record of an application still holding the debug port.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function alive(pid) {
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Why the application cannot be shown here, or null when it can.
 *
 * Only Linux is answerable this way, and only in one direction. An Electron
 * build with no X or Wayland display starts, fails, and exits — and everything
 * downstream reports the timeout instead, which sends whoever reads it looking
 * at the build. Naming the cause costs one environment lookup.
 *
 * macOS and Windows are deliberately not checked. Neither has an equivalent
 * variable, an interactive session on both usually has a desktop, and refusing
 * to launch because this function could not prove otherwise would break the one
 * platform that is known to work in order to guess about the other two. Getting
 * it wrong here is one confusing failure; guessing wrong the other way is a
 * command that refuses to run at all.
 *
 * `validate run` is not affected on any platform: it executes the repository's
 * own e2e script, and upstream already wraps those in `xvfb-maybe`.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} [os] defaults to the host; a parameter so the other two platforms are testable from either
 * @returns {string|null}
 */
export function displayProblem(env, os = platform()) {
  if (os !== 'linux') return null;
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return null;

  return (
    'no display: neither DISPLAY nor WAYLAND_DISPLAY is set, so the application would start and exit ' +
    'before CDP came up. Run under a virtual display — `xvfb-run -a pdkit validate launch …` — or set ' +
    'DISPLAY if one is available'
  );
}

/**
 * Start the built application with remote debugging on, and wait until CDP
 * answers.
 *
 * The shape is taken from upstream's own runner
 * (tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts): spawn with
 * --remote-debugging-port, poll /json/version, then connect. Which is the whole
 * answer to "can Playwright drive podman-desktop" — the repository has been
 * doing it in CI. pdkit stops at the endpoint: connecting to it is the MCP
 * server's job, and the plugin neither ships nor enables that server.
 *
 * Detached on purpose. The application has to outlive the pdkit process that
 * started it, or the agent would have nothing to drive by the time this
 * command returned.
 *
 * @param {{issue: number, repoRoot: string, port?: number, config?: object, app?: {binary?: unknown, args?: unknown}, home?: string, timeoutMs?: number, env?: Record<string, string|undefined>}} input
 *   app from `trustedApp`: the binary is never read from `config`, which a repository layer reaches
 * @param {Records} records
 * @returns {Promise<{ok: boolean, app?: Record_['app'], error?: string, alreadyRunning?: boolean}>}
 */
export async function launch(input, { read, blank, save }) {
  const home = input.home ?? resolveHome();
  const config = input.config ?? {};
  const port = input.port ?? Number(get(config, 'validation.app.debug_port') ?? DEFAULT_PORT);
  const timeoutMs = input.timeoutMs ?? parseDuration(get(config, 'validation.app.startup_timeout')) ?? DEFAULT_STARTUP_MS;

  const record = (await read(input.issue, { home })) ?? blank(input.issue);

  // A previous launch still running is not a failure — it is the thing the
  // caller wanted. Spawning a second copy on the same port would produce an app
  // that starts and immediately fails to bind, which reads as "the build is
  // broken" to everyone who sees it afterwards.
  if (record.app && alive(record.app.pid) && (await ready(record.app.port))) {
    return { ok: true, app: record.app, alreadyRunning: true };
  }

  const squatter = await probePort(port);
  if (squatter === 'ready') {
    return {
      ok: false,
      error:
        `something is already answering CDP on port ${port} and it is not this issue's application. ` +
        'Stop it, or set validation.app.debug_port to a free port',
    };
  }
  if (squatter === 'occupied') {
    return {
      ok: false,
      error:
        `something holds port ${port} without answering CDP — usually an application from an earlier run that ` +
        'did not exit cleanly. Find it with `lsof -ti tcp:' +
        `${port}\` and kill it, or set validation.app.debug_port to a free port`,
    };
  }

  const display = displayProblem(input.env ?? process.env);
  if (display) return { ok: false, error: display };

  const binary = await resolveBinary({ repoRoot: input.repoRoot, app: input.app, env: input.env });
  if (!binary.ok) return { ok: false, error: binary.error };

  // A previous app for this issue means the caller is going round again, which
  // is the normal shape of a validation run — poke, fix, relaunch, poke. Worth
  // saying, because the first tool call afterwards fails once (see below).
  const relaunch = Number(record.launches ?? 0) > 0;

  const child = spawn(binary.command, [...binary.args, `--remote-debugging-port=${port}`], {
    cwd: input.repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(input.env ?? {}) },
  });

  const spawned = await new Promise((done) => {
    child.once('spawn', () => done({ ok: true }));
    child.once('error', (error) => done({ ok: false, error: error.message }));
  });
  if (!spawned.ok) return { ok: false, error: `${binary.command}: ${spawned.error}` };

  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready(port)) {
      const app = {
        pid: child.pid,
        port,
        endpoint: `http://127.0.0.1:${port}`,
        binary: binary.command,
        startedAt: new Date().toISOString(),
      };
      await save({ ...record, app, launches: Number(record.launches ?? 0) + 1 }, { home });
      await appendJournal({ issue: input.issue, event: 'app-launched', detail: `pid ${app.pid}, ${app.endpoint}` }, { home });
      return { ok: true, app, relaunch };
    }

    // The process dying before CDP came up is the more useful failure, and
    // waiting out the full timeout to report it would hide the cause.
    if (!alive(child.pid)) {
      return { ok: false, error: `${binary.command} exited before the CDP endpoint came up (${binary.source})` };
    }

    await wait(PROBE_INTERVAL_MS);
  }

  try {
    process.kill(child.pid);
  } catch {
    // Already gone. Nothing to clean up, and nothing worth reporting over the
    // timeout that brought us here.
  }

  return { ok: false, error: `the CDP endpoint did not answer within ${Math.round(timeoutMs / 1000)}s` };
}

/**
 * Stop the application this issue started.
 *
 * @param {{issue: number, home?: string, timeoutMs?: number, port?: number, config?: object}} input
 * @param {Records} records
 * @returns {Promise<{ok: boolean, stopped?: boolean, error?: string}>}
 */
export async function stop(input, { read, save }) {
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });

  if (!record?.app) {
    // "Nothing was running" is only true if nothing is running. The record can
    // be lost — cleared, rotated, an issue directory removed — while the
    // application it described is still up, and reporting a clean stop then is
    // false in the direction that matters: the user walks away from a live
    // Electron process holding the debug port, and the next launch refuses.
    const port = input.port ?? Number(get(input.config ?? {}, 'validation.app.debug_port') ?? DEFAULT_PORT);
    if (await ready(port)) {
      return {
        ok: false,
        stopped: false,
        error:
          `no application is recorded for issue ${input.issue}, but something is still answering CDP on port ${port}. ` +
          'It was probably started for another issue, or its record was removed while it was running — stop it by hand',
      };
    }
    return { ok: true, stopped: false };
  }

  const { pid } = record.app;
  if (!alive(pid)) {
    await save({ ...record, app: null }, { home });
    return { ok: true, stopped: false };
  }

  try {
    process.kill(pid);
  } catch (error) {
    return { ok: false, error: `could not stop pid ${pid}: ${error.message}` };
  }

  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  while (alive(pid) && Date.now() < deadline) await wait(100);

  await save({ ...record, app: null }, { home });
  await appendJournal({ issue: input.issue, event: 'app-stopped', detail: `pid ${pid}` }, { home });

  return { ok: true, stopped: true };
}

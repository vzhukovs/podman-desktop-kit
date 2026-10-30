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


// The one way this plugin runs git.
//
// Seven modules grew their own wrapper, and each settled on a different answer
// to the same questions: what a refusal returns, whether output is trimmed, how
// much output fits. Those answers are load-bearing — a caller that compares a
// sha, or hands a diff to a digest, depends on the exact string — so they are
// kept, one function per answer, and what is shared is only how git is started.
//
// The runner is the promise form, `(file, args, options)`, the shape
// `promisify(execFile)` has, rather than the callback form lib/gh.js takes:
// every caller of git already calls that shape, and the one existing test seam
// (lib/worktree.js) injects it.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * @typedef {object} GitOptions
 * @property {string} cwd
 * @property {number} [maxBuffer] left out, execFile's own default applies
 * @property {Function} [exec] `(file, args, options) => Promise<{stdout, stderr}>`
 */

/**
 * Run git and return what execFile returned, or throw what it threw.
 *
 * execFile, never a shell: refs, paths and commit messages end up in argv.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function run(args, options) {
  const exec = options.exec ?? promisify(execFile);
  const settings = { cwd: options.cwd, encoding: 'utf8' };
  // Not `maxBuffer: undefined`: execFile spreads options over its defaults,
  // and an explicit undefined is no cap at all. A caller that never set one
  // keeps execFile's.
  if (options.maxBuffer !== undefined) settings.maxBuffer = options.maxBuffer;

  return exec('git', args, settings);
}

/**
 * Trimmed stdout, or null when git refuses — "not a repository" is an answer,
 * not a crash. Was `git` in lib/repo.js.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<string|null>}
 */
export async function trimmedOrNull(args, options) {
  try {
    const { stdout } = await run(args, options);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Stdout without trailing whitespace, or null when git refuses. Leading
 * whitespace is content (a diff line, a porcelain status). Was `gitOut` in
 * lib/pr.js.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<string|null>}
 */
export async function trimmedEndOrNull(args, options) {
  try {
    const { stdout } = await run(args, options);
    return stdout.replace(/\s+$/, '');
  } catch {
    return null;
  }
}

/**
 * Both streams as git wrote them, success or not. Was `git` in
 * lib/checkpoint.js.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export async function result(args, options) {
  try {
    const { stdout, stderr } = await run(args, options);
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) };
  }
}

/**
 * Both streams, trimmed, success or not. Was `git` in lib/worktree.js.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export async function trimmedResult(args, options) {
  try {
    const { stdout, stderr } = await run(args, options);
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? error.message).trim() };
  }
}

/**
 * Whether git succeeded, when the output is not the point. Was `gitOk` in
 * lib/slice.js.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<boolean>}
 */
export async function succeeds(args, options) {
  try {
    await run(args, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether git succeeded, and everything it said either way, stdout then
 * stderr, trimmed. Was `gitTry` in lib/slice.js.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<{ok: boolean, output: string}>}
 */
export async function attempt(args, options) {
  try {
    const { stdout, stderr } = await run(args, options);
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error.message ?? error) };
  }
}

/**
 * Stdout as git wrote it; a refusal throws. Was `gitText` in lib/slice.js, and
 * is what the direct `run('git', …)` calls elsewhere amount to.
 *
 * The refusal is execFile's own error, untouched — callers read its `stderr`
 * and `code`. The exception is a missing git, which execFile reports as
 * `spawn git ENOENT`: true, and no help to whoever reads it.
 *
 * @param {string[]} args
 * @param {GitOptions} options
 * @returns {Promise<string>}
 */
export async function text(args, options) {
  try {
    const { stdout } = await run(args, options);
    return stdout;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error('git is not installed — see the required dependencies in README.md', { cause: error }), {
        code: 'ENOENT',
      });
    }
    throw error;
  }
}

/**
 * Run git with `input` on its stdin: whether it exited 0, the exit code, and
 * stderr. `error` is set instead of `code` when git could not be started. Was
 * `apply` in lib/slice.js, the one caller that feeds git.
 *
 * spawn rather than execFile: the patch goes in on stdin, and execFile has no
 * `input` — it accepts the option and ignores it, leaving `git apply -` waiting
 * on a stdin nobody ever writes to. Silent, and indistinguishable from a slow
 * verification until it never finishes.
 *
 * @param {string[]} args
 * @param {string} input
 * @param {{cwd: string, spawn?: Function}} options `spawn` has child_process.spawn's shape
 * @returns {Promise<{ok: boolean, code: number|null, stderr: string, error?: string}>}
 */
export function withStdin(args, input, options) {
  return new Promise((resolve) => {
    const child = (options.spawn ?? spawn)('git', args, { cwd: options.cwd });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // git closes stdin as soon as it refuses the patch; without this the EPIPE
    // arrives as an unhandled error and takes the process with it.
    child.stdin.on('error', () => {});

    child.on('error', (error) => resolve({ ok: false, code: null, stderr, error: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr }));

    child.stdin.end(input);
  });
}

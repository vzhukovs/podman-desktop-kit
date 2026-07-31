// SPDX-License-Identifier: Apache-2.0

// Capturing real command output for receipts and preflight proof.
//
// The whole discipline rests on "done" meaning attached output rather than a
// summary. That makes this module the one place where output compression is
// unacceptable: if rtk (or anything like it) shrinks `pnpm test` output, the
// receipt records a claim, and the auditor loses the ability to tell "the test
// passed" from "the agent believes the test passed".
//
// So evidence commands run with rtk explicitly disabled. Token savings stay
// where they belong — navigation and reconnaissance, not proof.

import { exec } from 'node:child_process';

/** Environment applied to every evidence run. */
export const EVIDENCE_ENV = {
  // Confirm the exact variable against the rtk docs before enabling rtk
  // (spec section 13, open item 2).
  RTK_DISABLE: '1',
};

/** Ten minutes. `pnpm test:main` is not fast, and a killed run proves nothing. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How much output to hold. Test suites are verbose and the point of this
 * module is to keep all of it.
 */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {object} Capture
 * @property {string} command
 * @property {number|null} exitCode   null when the process was killed
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {string} at              ISO 8601
 * @property {boolean} complete       false when the output was cut short or the run was killed
 * @property {string} [incompleteBecause]
 */

/**
 * Run a command and capture its raw output.
 *
 * A non-zero exit is a result, not a failure: preflight needs the output of a
 * failing test run at least as much as a passing one. The only things reported
 * as incomplete are a timeout and an output cap, because those are the cases
 * where what was captured is not what the command produced — and evidence that
 * silently lost its tail is worse than no evidence, since it still looks like
 * proof.
 *
 * @param {{command: string, cwd?: string, timeoutMs?: number, env?: Record<string, string>}} input
 * @returns {Promise<Capture>}
 */
export async function capture(input) {
  const command = String(input?.command ?? '');
  if (command.trim() === '') throw new Error('capture: no command given');

  const startedAt = new Date();
  const start = process.hrtime.bigint();

  const result = await new Promise((resolve) => {
    exec(
      command,
      {
        cwd: input.cwd ?? process.cwd(),
        env: { ...process.env, ...EVIDENCE_ENV, ...(input.env ?? {}) },
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });

  const durationMs = Number((process.hrtime.bigint() - start) / 1000000n);
  const { error } = result;

  let complete = true;
  let incompleteBecause;

  if (error) {
    if (error.killed && error.signal) {
      complete = false;
      incompleteBecause = `killed by ${error.signal} after ${durationMs}ms`;
    } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      complete = false;
      incompleteBecause = `output exceeded ${MAX_OUTPUT_BYTES} bytes and was cut short`;
    }
  }

  return {
    command,
    // error.code is the exit status for a normal failure and a string for a
    // spawn-level problem; only the number is an exit code.
    exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs,
    at: startedAt.toISOString(),
    complete,
    ...(incompleteBecause ? { incompleteBecause } : {}),
  };
}

/**
 * Write a receipt for a task from captured runs.
 *
 * @param {{issue: number, taskId: string, runs: Array<object>}} _input
 * @returns {Promise<string>} path written
 */
export async function writeReceipt(_input) {
  // TODO(stage 2)
  throw new Error('not implemented');
}

/**
 * Whether a receipt contains real captured output rather than prose. Backs the
 * TaskCompleted hook, so it must reject a plausible-looking narrative.
 *
 * @param {string} _content
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateReceipt(_content) {
  // TODO(stage 2)
  throw new Error('not implemented');
}

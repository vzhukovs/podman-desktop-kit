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

/** Environment applied to every evidence run. */
export const EVIDENCE_ENV = {
  // Confirm the exact variable against the rtk docs before enabling rtk
  // (spec section 13, open item 2).
  RTK_DISABLE: '1',
};

/**
 * Run a command and capture its raw output.
 *
 * @param {{command: string, cwd?: string, timeoutMs?: number}} _input
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, durationMs: number, command: string, at: string}>}
 */
export async function capture(_input) {
  // TODO(stage 0)
  throw new Error('not implemented');
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

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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PLUGIN_ROOT } from './config.js';
import { write as writeArtefact } from './render.js';

/** Environment applied to every evidence run. */
export const EVIDENCE_ENV = {
  // rtk's own name for its per-command bypass, confirmed against its
  // documentation (docs/guide/getting-started/configuration.md). It was
  // RTK_DISABLE here until stage 2, which is a variable rtk has never heard of
  // — the bypass would have done nothing, and done it silently.
  RTK_DISABLED: '1',
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
 * The text a receipt records for a run: the command as typed, then everything
 * it printed. Same shape the preflight checks attach, so a reader who has seen
 * one has seen both.
 *
 * Always ends with a newline. Not cosmetic: the digest is taken over this text
 * and recomputed from the file, where the fence forces a final newline anyway.
 * Without normalizing here, a command whose last line is unterminated would
 * produce a receipt that fails its own validation.
 *
 * @param {Capture} run
 * @returns {string}
 */
export function transcript(run) {
  const text = `$ ${run.command}\n${run.stdout ?? ''}${run.stderr ?? ''}`;
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Digest of a transcript. What makes a receipt tamper-evident: it is taken over
 * the block that ends up in the file, so recomputing it from the file answers
 * "is this still what the command printed".
 *
 * @param {string} text
 * @returns {string} `sha256:<hex>`
 */
export function digest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Wrap a transcript in a fence long enough to survive its own content.
 *
 * Test output contains fenced code often enough that a fixed three-backtick
 * fence would break the file rather than the argument — and a receipt whose
 * output block ends early is a receipt that lost its tail while still looking
 * whole.
 *
 * @param {string} text
 * @returns {string}
 */
export function fence(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));

  return `${ticks}\n${text.endsWith('\n') ? text : `${text}\n`}${ticks}`;
}

/**
 * Write a receipt for a task from a captured run.
 *
 * Takes a Capture, and Capture is only produced by capture() above. That is the
 * enforcement: there is no parameter for output text, so "summarise the run
 * convincingly" is not a path that exists rather than one that is checked for.
 *
 * `path` exists because slice verification needs exactly this artefact under a
 * different name (`verify/S1.md`). One format and one validator for both: the
 * question they answer — is this a real capture — is the same question, and a
 * second near-identical writer is how one of them quietly stops being checked.
 *
 * @param {{issue: number, taskId: string, run: Capture, path?: string, commit?: string|null, files?: string[], home?: string}} input
 * @returns {Promise<{path: string, digest: string}>}
 */
export async function writeReceipt(input) {
  const run = input.run;
  if (!run || typeof run.command !== 'string') throw new Error('writeReceipt: no captured run given');

  const text = transcript(run);
  const evidence = digest(text);

  const version = JSON.parse(await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;

  const path = await writeArtefact({
    issue: input.issue,
    template: 'receipt',
    path: input.path ?? `receipts/${input.taskId}.md`,
    home: input.home,
    values: {
      taskId: input.taskId,
      issue: input.issue,
      completedAt: run.at,
      commit: input.commit ?? '—',
      // A killed run has no exit code, and printing one it does not have would
      // be the single most misleading field in the file.
      exitCode: run.exitCode === null ? 'none — the process was killed' : run.exitCode,
      durationMs: run.durationMs,
      capture: run.complete ? 'complete' : `incomplete — ${run.incompleteBecause ?? 'reason not recorded'}`,
      evidence: `${evidence} (pdkit ${version})`,
      command: run.command,
      output: fence(text),
      files: input.files?.length ? input.files : '—',
    },
  });

  return { path, digest: evidence };
}

/**
 * @typedef {object} ReceiptCheck
 * @property {boolean} ok            the receipt is a real capture
 * @property {string} [reason]       why not
 * @property {number|null} [exitCode]
 * @property {boolean} [complete]
 * @property {string} [command]
 */

/** `## Output` followed by a fenced block of any fence length. */
const OUTPUT_BLOCK = /^## Output\b[^\n]*\n(?:<!--[\s\S]*?-->\n)?(`{3,})\n([\s\S]*?)\n\1[ \t]*$/m;

const EXIT_CODE = /^- Exit code:\s*(-?\d+|none\b.*)$/m;
const CAPTURE = /^- Capture:\s*(complete|incomplete\b.*)$/m;
const EVIDENCE = /^- Evidence:\s*(sha256:[0-9a-f]{64})\b/m;
const COMMAND = /^## Command\b[^\n]*\n```bash\n([\s\S]*?)\n```/m;

/**
 * Whether a receipt is a real capture.
 *
 * This answers one question and refuses the neighbouring one: it does NOT say
 * whether the run succeeded. A failing `pnpm test:main` produces a perfectly
 * valid receipt, and it is the receipt worth having most — attaching it is how
 * a task reports that it is not done. Deciding "not done" belongs to the
 * TaskCompleted hook, which reads exitCode from here. A validator that refused
 * red receipts would make them the ones it pays to not write.
 *
 * @param {string} content
 * @returns {ReceiptCheck}
 */
export function validateReceipt(content) {
  const text = String(content ?? '');

  const block = OUTPUT_BLOCK.exec(text);
  if (!block) return { ok: false, reason: 'there is no fenced Output block — nothing was captured' };

  const evidence = EVIDENCE.exec(text);
  if (!evidence) {
    return {
      ok: false,
      reason: 'there is no Evidence digest. Receipts are written by `pdkit receipt write`, which adds one; a file without it was written by something else',
    };
  }

  const captured = block[2];
  const recomputed = digest(`${captured}\n`);
  if (recomputed !== evidence[1]) {
    return { ok: false, reason: `the Output block does not match its Evidence digest — the receipt was edited after it was captured` };
  }

  const capture = CAPTURE.exec(text);
  if (!capture) return { ok: false, reason: 'there is no Capture line saying whether the output is complete' };
  if (capture[1] !== 'complete') {
    return { ok: false, reason: `the capture is ${capture[1]} — evidence that lost its tail still looks like proof, so it is not accepted as one` };
  }

  const command = COMMAND.exec(text);
  if (!command) return { ok: false, reason: 'there is no Command block saying what was run' };
  if (!captured.startsWith(`$ ${command[1]}\n`) && captured.trimEnd() !== `$ ${command[1]}`) {
    return { ok: false, reason: 'the Output block does not open with the command from the Command block' };
  }

  const exit = EXIT_CODE.exec(text);
  if (!exit) return { ok: false, reason: 'there is no Exit code line' };

  return {
    ok: true,
    exitCode: exit[1].startsWith('none') ? null : Number.parseInt(exit[1], 10),
    complete: true,
    command: command[1],
  };
}

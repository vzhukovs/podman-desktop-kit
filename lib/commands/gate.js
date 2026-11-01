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

// `pdkit gate`: issue, check, spend or revoke consent tokens.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import * as gate from '../gate.js';
import { EXIT, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'branch', 'pr', 'kind', 'ttl'];

export const ACTIONS = {
  revoke,
  open: withSubject(open),
  verify: withSubject(verify),
  close: withSubject(close),
};

/**
 * Issue, check, spend or revoke consent tokens.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0];

  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : withSubject(unknown);
  return handler({ action }, flags);
}

async function revoke() {
  const revoked = await gate.revokeAll();
  process.stdout.write(`${revoked} token${revoked === 1 ? '' : 's'} revoked\n`);
  return EXIT.OK;
}

/**
 * Every action but revoke is about one subject — a branch, or a reply on a
 * pull request — and it is required before the action runs, an unknown
 * action included.
 *
 * @param {(context: object, flags: Record<string, string|boolean>) => Promise<number>} handler
 */
function withSubject(handler) {
  return async (context, flags) => {
    const { action } = context;
    const branch = typeof flags.branch === 'string' ? flags.branch : undefined;
    const prNumber = Number.parseInt(String(flags.pr), 10);
    const target = {
      branch,
      pr: Number.isInteger(prNumber) ? prNumber : undefined,
      kind: typeof flags.kind === 'string' ? flags.kind : undefined,
    };

    const subject = gate.subjectOf(target);
    if (!subject) {
      process.stderr.write(`pdkit gate ${action ?? ''}: --branch <b>, or --pr <k> --kind reply, is required\n`);
      return EXIT.ERROR;
    }

    return handler({ ...context, target, subject }, flags);
  };
}

async function open({ target }, flags) {
  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit gate open: --issue is required\n');
    return EXIT.ERROR;
  }

  const ttlMs = flags.ttl === undefined ? undefined : gate.parseDuration(String(flags.ttl));
  const result = await gate.open({ issue, ...target, ttlMs: ttlMs ?? undefined });

  if (!result.ok) {
    process.stderr.write(`pdkit gate open: ${result.error}\n`);
    return EXIT.ERROR;
  }
  if (flags.json) printJson(result);
  else process.stdout.write(`${result.kind} token for ${result.subject}, valid until ${result.expiresAt}\n`);
  return EXIT.OK;
}

async function verify({ target, subject }, flags) {
  const result = await gate.verify(target);
  if (flags.json) printJson(result);
  else process.stdout.write(result.valid ? `valid ${subject.kind} token for ${subject.subject}\n` : `${result.reason}\n`);
  return result.valid ? EXIT.OK : EXIT.ERROR;
}

async function close({ target, subject }) {
  const result = await gate.close(target);
  if (!result.ok) {
    process.stderr.write(`pdkit gate close: ${result.error}\n`);
    return EXIT.ERROR;
  }
  process.stdout.write(`${subject.kind} token for ${subject.subject} spent\n`);
  return EXIT.OK;
}

async function unknown({ action }) {
  process.stderr.write(`pdkit gate: unknown action "${action ?? ''}" (open, verify, close, revoke)\n`);
  return EXIT.ERROR;
}

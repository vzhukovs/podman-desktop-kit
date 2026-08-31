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

// Shell commands for fixtures, in the one language both shells run.
//
// `capture()` and every `Done when` hand their command to the platform shell,
// which is `/bin/sh` on POSIX and `cmd.exe` on Windows. The fixtures were
// written in the first of those and read as nonsense in the second: `;` is not
// a separator in cmd, so `echo broken >&2; exit 3` echoes its own tail and
// exits 0 — a test that asserted a red run got a green one, and said the
// product was wrong.
//
// `echo` is the subtler one. It exists in both, and it appends CRLF in cmd, so
// a test comparing stdout to `'ok\n'` fails on a difference it never meant to
// be about.
//
// So: node, which is running this suite and is therefore guaranteed present,
// and whose output is the bytes we asked for on every platform. The quoting
// survives both shells — double quotes are what cmd understands, and `sh`
// leaves a backslash alone inside them unless it precedes `$`, a backtick, a
// quote or another backslash.

/**
 * A command that writes exactly `text` to stdout and exits 0.
 *
 * @param {string} text
 * @returns {string}
 */
export function emits(text) {
  return `node -e "process.stdout.write(${literal(text)})"`;
}

/**
 * A command that writes to stdout and/or stderr and exits with `code`.
 *
 * @param {number} code
 * @param {{out?: string, err?: string}} [streams]
 * @returns {string}
 */
export function exits(code, streams = {}) {
  const parts = [];
  if (streams.out) parts.push(`process.stdout.write(${literal(streams.out)})`);
  if (streams.err) parts.push(`process.stderr.write(${literal(streams.err)})`);
  parts.push(`process.exit(${code})`);
  return `node -e "${parts.join(';')}"`;
}

/**
 * A JS string literal safe inside a double-quoted shell word on both shells.
 *
 * Single quotes around it, because the outer quoting is double. Newlines go in
 * as the two characters `\` and `n`, which neither shell touches and node reads
 * as the escape — a literal newline inside the command would end it in cmd.
 *
 * @param {string} text
 * @returns {string}
 */
function literal(text) {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
}

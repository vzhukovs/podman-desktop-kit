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

/** `10m`, `30s`, `1h`. A bare number is milliseconds. */
const DURATION = /^(\d+)\s*(ms|s|m|h)?$/;

const UNIT_MS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };

/**
 * Parse a duration from the config.
 *
 * @param {unknown} value
 * @returns {number|null} milliseconds, or null when it does not parse
 */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const match = DURATION.exec(String(value ?? '').trim());
  if (!match) return null;

  return Number.parseInt(match[1], 10) * UNIT_MS[match[2] ?? 'ms'];
}

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

// The skip of a check whose input is the PR body, before the body exists.
//
// A leaf: the checks under checks/ import it instead of index.js, the runner
// that loads them. index.js re-exports both names.

/** @typedef {import('./index.js').CheckResult} CheckResult */

/** How every check ends its summary when it is the body it lacks. */
export const BODY_NOT_DRAFTED = 'the PR body is not drafted yet';

/**
 * The skip of a check that cannot judge until the PR body is drafted.
 *
 * One place for the phrase and the marker, so the two cannot drift apart: the
 * summary is `lead` followed by BODY_NOT_DRAFTED, and `waitingFor: 'body'` is
 * what `waitingForBody` counts. Keys come out in the order the checks wrote them
 * by hand, so --json is unchanged once the marker is dropped.
 *
 * @param {{id: string, blocking: boolean, lead?: string, remedy: string, output?: string}} input
 *   `lead` carries its own separator: `'the public API is touched; '`
 * @returns {CheckResult}
 */
export function skipForBody({ id, blocking, lead = '', ...rest }) {
  return { id, status: 'skip', blocking, summary: `${lead}${BODY_NOT_DRAFTED}`, ...rest, waitingFor: 'body' };
}

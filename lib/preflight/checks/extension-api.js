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

// Preflight check: extension-api
//
// Touching packages/extension-api/src/extension-api.d.ts brings obligations
// that a reviewer will look for: backward compatibility and disposal. This
// check does not judge whether they are met — it requires that the PR body
// says something about both, because a reviewer who has to ask is a review
// round trip.

import { EXTENSION_API_DTS } from '../../upstream.js';

/** @type {string} */
export const id = 'extension-api';

/** @type {boolean} */
export const blocking = true;

const COMPATIBILITY = /backward|backwards|compatib|breaking change/i;
const DISPOSAL = /dispos|leak|unregister|teardown/i;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const touched = context.changedFiles.some((file) => file.replaceAll('\\', '/').endsWith(EXTENSION_API_DTS.replaceAll('\\', '/')));
  if (!touched) {
    return { id, status: 'skip', blocking, summary: 'the public API declaration is untouched' };
  }

  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: 'the public API is touched; the PR body is not drafted yet',
      remedy: 'draft the body, then run preflight again — this check has to read it',
    };
  }

  const missing = [];
  if (!COMPATIBILITY.test(context.prBody)) missing.push('backward compatibility');
  if (!DISPOSAL.test(context.prBody)) missing.push('disposal');

  if (missing.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the PR body says nothing about ${missing.join(' or ')}`,
      remedy: `${EXTENSION_API_DTS} is public API. Say what happens to extensions built against the old shape, and what disposes of what`,
    };
  }

  return { id, status: 'pass', blocking, summary: 'the body covers compatibility and disposal' };
}

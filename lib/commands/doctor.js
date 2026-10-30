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


import { diagnose, format } from '../doctor.js';
import { EXIT, PLUGIN_ROOT, printJson, readVersion } from './support.js';

export const flags = ['gate-selftest'];

/**
 * Environment check.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const version = await readVersion();
  const report = await diagnose({
    cwd: typeof flags.repo === 'string' ? flags.repo : undefined,
    pluginRoot: PLUGIN_ROOT,
    gateSelftest: Boolean(flags['gate-selftest']),
  });

  if (flags.json) printJson({ version, pluginRoot: PLUGIN_ROOT, ...report });
  else process.stdout.write(format(report, { version }));

  // Warnings do not fail the check. They are things to know, not things that
  // stop pdkit from working, and a doctor that exits non-zero on every
  // optional gap stops being run.
  return report.status === 'fail' ? EXIT.ERROR : EXIT.OK;
}

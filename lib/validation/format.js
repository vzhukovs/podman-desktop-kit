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

// Validation as an entity (spec section 2.2, invariant 5) — the part that shows
// the record to a person: validation.md and the terminal.
//
// The verdicts are imported from lib/validation/verdict.js. Reading the record
// arrives as a parameter (Verdicts below): it lives in lib/validation.js, the
// one writer of the record, which re-exports this file, and importing it back
// would be a cycle.

import { resolveHome } from '../config.js';
import { write as writeArtefact } from '../render.js';
import { outcomeOf, statusOf } from './verdict.js';

/** @typedef {import('../validation.js').Record_} Record_ */
/** @typedef {import('../validation.js').Step} Step */

/**
 * What rendering needs from lib/validation.js, handed over by its facade.
 *
 * @typedef {object} Verdicts
 * @property {(issue: number, options?: {home?: string}) => Promise<Record_|null>} read
 */

/**
 * @param {Step} step
 * @returns {string}
 */
function evidenceCell(step) {
  if (!step.evidence) return '—';
  const short = step.evidence.digest.slice(0, 14);
  return `\`${step.evidence.path}\` (${short}…)`;
}

/**
 * Placeholder values for templates/validation.md.
 *
 * Every column that carries a verdict is computed here from the record. The
 * only strings that arrive from outside are the ones an agent legitimately
 * writes — what was checked, what was expected, what it saw.
 *
 * @param {Record_} record
 * @param {{stabilityRuns?: number}} [options]
 * @returns {Record<string, unknown>}
 */
export function renderValues(record, options = {}) {
  const { outcome, gaps } = outcomeOf(record);
  const wanted = options.stabilityRuns ?? 3;

  const rows = record.steps.map((step) =>
    [
      '',
      step.id,
      step.requirements.join(', ') || '—',
      step.title,
      step.expected ?? '—',
      step.observed ?? '—',
      evidenceCell(step),
      // The derived status either way, and what replaced it when it was set
      // aside. Printing only "superseded" would hide whether the step that was
      // set aside had failed or shown nothing, which is the part a reviewer of
      // this record is entitled to see.
      step.superseded ? `${statusOf(step)}, set aside for ${step.superseded.by}` : statusOf(step),
      '',
    ].join(' | ').trim(),
  );

  const aside = record.steps.filter((step) => step.superseded);

  const e2e = record.e2e.spec
    ? `${record.e2e.spec} — ${record.e2e.consecutive}/${wanted} consecutive green`
    : 'no candidate';

  const detail = record.e2e.spec
    ? [
        `- Spec: \`${record.e2e.spec}\``,
        `- Digest: \`${record.e2e.digest}\``,
        `- Runs: ${record.e2e.runs.length}, ${record.e2e.consecutive} green in a row (needs ${wanted})`,
        ...record.e2e.runs.map((run) => `  - ${run.at} exit ${run.exitCode ?? 'killed'} — \`${run.evidence}\``),
      ].join('\n')
    : '_No e2e candidate was codified. If the plan said `e2e coverage: required`, this is a gap, not a decision._';

  return {
    issue: record.issue,
    outcome,
    stepCount: record.steps.length,
    withEvidence: record.steps.filter((step) => step.evidence).length,
    e2e,
    validatedAt: record.updatedAt ?? 'never',
    steps: rows.length ? rows : ['| — | — | nothing was checked | — | — | — | — |'],
    gaps: gaps.length
      ? gaps.map((step) => `- **${step.id}** ${step.title} — ${step.observed ?? 'no artefact and no observation'}`)
      : '_None: every step above has an artefact._',
    superseded: aside.length
      ? aside.map(
          (step) =>
            `- **${step.id}** ${step.title} (${statusOf(step)}) → **${step.superseded.by}**, ${step.superseded.at}\n` +
            `  - ${step.superseded.reason}`,
        )
      : '_None: every step above counts towards the outcome._',
    e2eDetail: detail,
  };
}

/**
 * Write validation.md from the record.
 *
 * @param {{issue: number, home?: string, stabilityRuns?: number}} input
 * @param {Verdicts} verdicts
 * @returns {Promise<{ok: boolean, path?: string, outcome?: string, error?: string}>}
 */
export async function render(input, verdicts) {
  const { read } = verdicts;
  const home = input.home ?? resolveHome();
  const record = await read(input.issue, { home });
  if (!record) return { ok: false, error: `issue ${input.issue} has no validation record` };

  const path = await writeArtefact({
    issue: input.issue,
    template: 'validation',
    path: 'validation.md',
    home,
    values: renderValues(record, { stabilityRuns: input.stabilityRuns }),
  });

  return { ok: true, path, outcome: outcomeOf(record).outcome };
}

/**
 * Terminal summary. Same division as lib/audit.js: it reports, it does not
 * grade — the one judgement here is the derived status of each step, and that
 * comes from the artefacts.
 *
 * @param {Record_|null} record
 * @returns {string}
 */
export function format(record) {
  if (!record || record.steps.length === 0) {
    return 'Nothing has been validated yet. `pdkit validate steps` says what is waiting.';
  }

  const { outcome, gaps } = outcomeOf(record);
  const lines = [`Outcome: ${outcome}`, ''];

  for (const step of record.steps) {
    const status = statusOf(step);
    const mark = step.superseded ? '⤳' : status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'observed' ? '📎' : '⚠️';
    lines.push(`  ${mark} ${step.id} ${step.title}`);
    if (step.superseded) lines.push(`     set aside for ${step.superseded.by}: ${step.superseded.reason}`);
    if (step.evidence) lines.push(`     ${step.evidence.kind}: ${step.evidence.path}`);
    else lines.push('     no artefact');
  }

  if (record.e2e.spec) {
    lines.push('', `  e2e: ${record.e2e.spec}, ${record.e2e.consecutive} green in a row`);
  }

  if (gaps.length > 0) {
    lines.push(
      '',
      `${gaps.length} step${gaps.length === 1 ? '' : 's'} without an artefact. This does not stop the transition —`,
      'it has to reach the reviewer instead: name them in Notes for reviewers, or preflight will.',
    );
  }

  return lines.join('\n');
}

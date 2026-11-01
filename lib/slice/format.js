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

// Slicing one change set into N atomic pull requests (spec section 4) — the
// part that shows the graph to a person: the terminal and slices.md.
//
// verifySlice() builds the slice alone, from main, in a scratch worktree.
// Green means the slice branches from main. Red means it needs a stack.
//
// The verification result is produced from a run rather than accepted from a
// caller. There is no parameter for "standalone: true" — the same argument
// that made receipts evidence rather than claims.

import { mergeOrder } from './graph.js';

/**
 * The values slices.md is rendered from.
 *
 * The verified columns are built here, from the graph, and the caller may only
 * add prose around them: `pdkit slice render` merges the agent's rationale on
 * top of these, and a rationale cannot overwrite a tick it did not earn.
 *
 * `given` is how that stays true rather than remaining a claim in a comment.
 * The CLI used to spread the `--values` file over these — `{ ...renderValues(
 * graph), ...values }` — so a values file carrying `rows` or `verifiedAt`
 * replaced the measured columns with whatever it said, in the one document
 * whose columns exist because they cannot be typed in.
 *
 * @param {import('../slice.js').Graph} graph
 * @param {Record<string, string>} [given]  prose from the caller; the measured keys win over it
 * @returns {Record<string, string>}
 */
export function renderValues(graph, given = {}) {
  const mark = (value) => (value === true ? '✅' : value === false ? '❌' : '—');

  const rows = graph.slices.map((slice) => {
    const verification = slice.verification;
    const inconclusive = verification?.baselineOk === false;
    // The commit the build stood on, in the column that makes the claim. A
    // `Standalone: ✅` beside `main` with no sha is checkable only by whoever
    // remembers to run `git merge-base`, and on 18835 nobody did until the pull
    // request was nearly open.
    const on = verification?.baseCommit ? ` from ${verification.baseCommit.slice(0, 12)}` : '';
    const standalone = !verification
      ? '— not verified'
      : inconclusive
        ? '⚠️ inconclusive — the base fails this too'
        : verification.standalone
          ? `${mark(verification.ok)}${on}`
          : `${mark(verification.ok)} stacked${slice.baseSlice === null ? '' : ` on #${slice.baseSlice}`}${on}`;

    return [
      '',
      slice.index,
      slice.branch,
      slice.layers.join(', ') || '—',
      slice.baseSlice === null ? graph.source.base : `#${slice.baseSlice}`,
      slice.files.length,
      slice.requirements.join(', ') || '—',
      standalone,
      verification ? mark(verification.revertsCleanly) : '—',
      '',
    ].join(' | ').trim();
  });

  const verifiedAt = graph.slices
    .map((slice) => slice.verification?.verifiedAt)
    .filter(Boolean)
    .sort()
    .pop();

  const rationale = graph.slices.map((slice) =>
    [
      `### #${slice.index} ${slice.title || slice.slug}`,
      `- Why separate: ${slice.whySeparate || '<not stated>'}`,
      `- Self-justifying without the next slice: ${slice.selfJustifying || '<not stated>'}`,
      ...(slice.commits?.length > 1
        ? [`- Commits: ${slice.commits.map((commit, position) => `${position + 1}. \`${commit.subject}\``).join('; ')}`]
        : []),
      ...(slice.supersedes?.length ? [`- Replaces: ${slice.supersedes.map((number) => `#${number}`).join(', ')}`] : []),
      '- Steps to check: <draft, filled out in /pd:pr>',
      '',
    ].join('\n'),
  );

  // Anything the caller passes goes in first and the measured keys are written
  // over it, so the order of what follows is the invariant rather than a habit.
  return {
    ...given,
    issue: String(graph.issue),
    strategy: graph.strategy,
    source: `${graph.source.base}...${graph.source.refName ?? graph.source.ref}`,
    verifiedAt: verifiedAt ? `${verifiedAt} by \`pdkit slice verify\`` : 'never — no slice has been built yet',
    rows: rows.join('\n'),
    mergeOrder: mergeOrderText(graph),
    hypothesis: hypothesisText(graph),
    // The one value an agent writes rather than earns: why each slice is
    // separate is a judgement, and the whole reason a person reads this file.
    rationale: typeof given.rationale === 'string' ? given.rationale : rationale.join('\n'),
  };
}

/**
 * The merge order as a person should read it.
 *
 * Independent slices have no order, and printing `#1 → #2 → #3` for them
 * invents one. On DESKTOP-19818 that line went into three PR bodies as
 * "merge #19829 → #19830 → #19831" about slices the graph called independent:
 * the order was real, the dependency behind it was not in the graph, and
 * upstream found it by merging one of them alone.
 *
 * @param {import('../slice.js').Graph} graph
 * @returns {string}
 */
export function mergeOrderText(graph) {
  const { order } = mergeOrder(graph.slices);
  if (order.length === 0) return '—';
  if (order.length === 1) return `#${order[0]}`;
  if (graph.slices.every((slice) => slice.baseSlice === null)) {
    return `any order — no slice is based on another (${order.map((index) => `#${index}`).join(', ')})`;
  }
  return order.map((index) => `#${index}`).join(' → ');
}

/**
 * What the plan said about the cut, beside what the graph is.
 *
 * @param {import('../slice.js').Graph} graph
 * @returns {string}
 */
export function hypothesisText(graph) {
  const said = graph.hypothesis;
  if (!said) return 'no plan, or no hypothesis in it';
  if (said.count === null) return 'the plan gives no slice count';

  const planned = `${said.count} slice${said.count === 1 ? '' : 's'}`;
  if (said.count === graph.slices.length) return `${planned} — the graph matches`;
  return `${planned} — the graph has ${graph.slices.length}${said.deviation ? `, because: ${said.deviation}` : ''}`;
}

/**
 * Render the graph for a terminal.
 *
 * @param {import('../slice.js').Graph} graph
 * @returns {string}
 */
export function format(graph) {
  const { cycle } = mergeOrder(graph.slices);
  const lines = [`slices: issue ${graph.issue} — ${graph.slices.length}, strategy ${graph.strategy}`, ''];

  for (const slice of graph.slices) {
    const verification = slice.verification
      ? `${slice.verification.ok ? '✔' : slice.verification.baselineOk === false ? '⚠' : '✘'} ` +
        `${slice.verification.standalone ? 'standalone' : 'stacked'}` +
        `${slice.verification.baseCommit ? ` from ${slice.verification.baseCommit.slice(0, 12)}` : ''} ${slice.verification.verifiedAt}` +
        `${slice.verification.baselineOk === false ? ' — the base fails this command too' : ''}`
      : '· not verified';

    lines.push(
      `  #${slice.index} ${slice.branch}`,
      `      base   ${slice.baseSlice === null ? graph.source.base : `#${slice.baseSlice}`}   layers ${slice.layers.join(', ') || '—'}   R ${slice.requirements.join(', ') || '—'}`,
      `      files  ${slice.files.length}`,
      `      verify ${verification}`,
    );
    for (const [position, commit] of (slice.commits ?? []).entries()) {
      const check = slice.commitChecks?.find((entry) => entry.commit === position + 1);
      const built = position + 1 === slice.commits.length ? 'the slice' : check ? (check.ok ? '✔ builds' : '✘ does not build') : '· not built';
      lines.push(`      commit ${position + 1}  ${commit.subject}  (${commit.files.length} files, ${built})`);
    }
    if (slice.supersedes?.length) lines.push(`      replaces ${slice.supersedes.map((number) => `#${number}`).join(', ')}`);
  }

  lines.push('', `  merge order: ${mergeOrderText(graph)}`);
  if (graph.hypothesis) lines.push(`  plan said:   ${hypothesisText(graph)}`);
  if (cycle.length > 0) lines.push(`  CYCLE among ${cycle.map((index) => `#${index}`).join(', ')}`);

  return `${lines.join('\n')}\n`;
}

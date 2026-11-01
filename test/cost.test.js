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

// Tests for lib/cost.js.
//
// The command exists to show "before" and "after" on one scale, so what is
// worth pinning is that the scale is honest: sums that are sums, a weighting
// that is the one documented, attribution that says where it stops, and a
// coverage figure that cannot be left out. Two of these were learned from the
// real corpus — one response written as several lines with the same usage, and
// subagents filed away from their session — and both are pinned here, because
// either one silently doubles or halves every number the command prints.
//
// Nothing here reads ~/.claude. Fixtures are built in memory, and the two tests
// that need files on disk write them to a temporary directory.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATTRIBUTION_WINDOW_MS,
  attributor,
  build,
  collect,
  compare,
  format,
  normalize,
  phaser,
  readUsage,
  scan,
  slugOf,
  tally,
  unattributedShare,
  unitsOf,
} from '../lib/cost.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-08-26T10:00:00Z');

/** @param {number} hours after T0 */
const at = (hours) => new Date(T0 + hours * HOUR).toISOString();

/** @param {object} over */
const call = (over = {}) => ({
  at: at(1),
  model: 'claude-sonnet-5',
  sessionId: 's1',
  agent: null,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  ...over,
});

/** @param {Partial<import('../lib/cost.js').Scan>} over */
const scanOf = (over = {}) => ({
  calls: [],
  compactions: [],
  dirs: ['/transcripts'],
  missing: [],
  files: 1,
  subagentFiles: 0,
  duplicateLines: 0,
  unreadableLines: 0,
  ...over,
});

/** @param {number} hours @param {number} issue @param {string} event */
const entry = (hours, issue, event) => ({ at: at(hours).replace(/\.\d{3}Z$/, 'Z'), issue, slice: null, event, detail: '' });

describe('the scale', () => {
  test('units are the documented weighting, and Opus is five times Sonnet', () => {
    const usage = { input: 1000, cacheRead: 10_000, cacheWrite: 800, output: 200 };
    // 1000 + 0.1·10000 + 1.25·800 + 5·200 = 1000 + 1000 + 1000 + 1000
    assert.equal(unitsOf(usage, 'claude-sonnet-5'), 4000);
    assert.equal(unitsOf(usage, 'claude-opus-5'), 20_000);
    assert.equal(unitsOf(usage, 'claude-opus-5-5'), 20_000);
  });

  test('a usage line without cache fields reads as zeros, not NaN', () => {
    const usage = readUsage({ input_tokens: 12, output_tokens: 3 });
    assert.deepEqual(usage, { input: 12, cacheRead: 0, cacheWrite: 0, output: 3 });
    assert.equal(unitsOf(usage, 'claude-sonnet-5'), 27);

    const totals = tally([call({ usage }), call({ usage: readUsage(undefined) })]);
    assert.equal(Number.isNaN(totals.units), false);
    assert.equal(totals.units, 27);
  });

  test('sums, averages and the peak over a known set of calls', () => {
    const totals = tally([
      call({ model: 'claude-opus-5', sessionId: 'a', usage: { input: 10, cacheRead: 100, cacheWrite: 0, output: 1 } }),
      call({ model: 'claude-opus-5', sessionId: 'a', usage: { input: 0, cacheRead: 300, cacheWrite: 20, output: 2 } }),
      call({ sessionId: 'a', agent: 'x1', usage: { input: 5, cacheRead: 55, cacheWrite: 0, output: 4 } }),
      call({ sessionId: 'b', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    ]);

    assert.equal(totals.calls, 4);
    assert.equal(totals.subagentCalls, 1);
    assert.equal(totals.cacheRead, 455);
    assert.equal(totals.output, 7);
    // contexts: 110, 320, 60, 0
    assert.equal(totals.avgContext, 122.5);
    assert.equal(totals.peakContext, 320);
    assert.equal(totals.opusShare, 0.5);
    // Parent sessions only; the subagent is an agent run, not a session.
    assert.equal(totals.sessions, 2);
    assert.equal(totals.agentRuns, 1);
    // (10 + 10 + 5)·5 + (30 + 25 + 10)·5 + (5 + 5.5 + 20) = 125 + 325 + 30.5
    assert.equal(totals.units, 480.5);
  });

  test('normalizing divides by what is known, and by nothing that is zero or unknown', () => {
    const per = normalize(1200, { tasks: 4, slices: 0, requirements: null, changedLines: 600, mergedPrs: 1, agentRuns: 3 });
    assert.equal(per.tasks, 300);
    assert.equal(per.slices, null);
    assert.equal(per.requirements, null);
    assert.equal(per.changedLines, 2);
    assert.equal(per.mergedPrs, 1200);
    assert.equal(per.agentRuns, 400);
  });
});

describe('attribution', () => {
  const issueOf = attributor([entry(0, 100, 'triaged'), entry(10, 200, 'triaged')]);

  test('a call inside the window after an entry belongs to that entry\'s issue', () => {
    assert.equal(issueOf(at(0)), 100);
    assert.equal(issueOf(at(5.9)), 100);
    assert.equal(issueOf(at(10.5)), 200);
  });

  test('a call further from the entry than the window belongs to nobody', () => {
    assert.equal(ATTRIBUTION_WINDOW_MS, 6 * HOUR);
    assert.equal(issueOf(at(6.1)), null);
  });

  test('a call before the first entry of all belongs to nobody', () => {
    assert.equal(issueOf(at(-1)), null);
  });

  test('entries without an issue do not claim calls', () => {
    const only = attributor([{ at: at(0), issue: null, event: 'denied' }]);
    assert.equal(only(at(1)), null);
  });

  test('the phase is the one the last transition before the call opened', () => {
    const phaseOf = phaser([entry(0, 1, 'worktree-create'), entry(1, 1, 'triaged'), entry(2, 1, 'plan-approved'), entry(3, 1, 'task-start')]);
    assert.equal(phaseOf(at(0.5)), 'triage');
    assert.equal(phaseOf(at(1.5)), 'plan');
    assert.equal(phaseOf(at(3.5)), 'exec');
  });

  test('the unattributed share is counted over every call in the window', () => {
    const report = build({
      scan: scanOf({
        calls: [call({ at: at(-2) }), call({ at: at(1) }), call({ at: at(2) }), call({ at: at(9) })],
      }),
      entries: [entry(0, 100, 'triaged')],
      records: {},
    });

    assert.equal(report.coverage.calls, 4);
    assert.equal(report.coverage.attributed, 2);
    assert.equal(report.coverage.unattributed, 2);
    assert.equal(report.coverage.unattributedShare, 0.5);
    assert.equal(unattributedShare(0, 0), null);
    assert.match(format(report), /50 % of 4 call\(s\) in the window mapped to an issue; 2 \(50 %/);
  });

  test('--since narrows the calls, not the journal that explains them', () => {
    const report = build({
      scan: scanOf({ calls: [call({ at: at(1) }), call({ at: at(3) })] }),
      entries: [entry(0, 100, 'triaged')],
      records: {},
      since: at(2),
    });
    assert.equal(report.coverage.calls, 1);
    assert.equal(report.coverage.attributed, 1);
  });
});

describe('the report', () => {
  const opus = { input: 0, cacheRead: 1000, cacheWrite: 0, output: 0 };
  const report = build({
    scan: scanOf({
      calls: [
        call({ at: at(0.5), model: 'claude-opus-5', usage: opus }),
        call({ at: at(1.5), model: 'claude-opus-5', usage: opus }),
        call({ at: at(1.6), model: 'claude-opus-5', usage: opus, agent: 'a1' }),
        call({ at: at(1.7), model: 'claude-opus-5', usage: opus }),
        call({ at: at(30.5), usage: opus }),
      ],
      compactions: [{ at: at(1.55), sessionId: 's1' }],
    }),
    entries: [entry(0, 100, 'worktree-create'), entry(1, 100, 'triaged'), entry(30, 300, 'quickfix')],
    records: {
      100: { route: 'standard', state: 'planned', tasks: 4, slices: 2, requirements: null, changedLines: null, mergedPrs: 0, unavailable: { requirements: 'no requirements allocated', changedLines: 'no open or merged pull request' } },
      300: { route: 'quickfix', state: 'quickfix', tasks: null, slices: null, requirements: null, changedLines: 10, mergedPrs: 1, unavailable: {} },
    },
  });
  const issue = report.issues.find((entry) => entry.issue === 100);

  test('splits an issue by phase, and the shares add up', () => {
    assert.deepEqual(
      issue.phases.map((phase) => [phase.phase, phase.calls]),
      [
        ['triage', 1],
        ['plan', 3],
      ],
    );
    assert.equal(issue.phases.reduce((sum, phase) => sum + phase.share, 0), 1);
    assert.equal(issue.totals.compactions, 1);
  });

  test('agent runs come from subagent transcripts, and the journal count stands beside them', () => {
    assert.equal(issue.denominators.agentRuns, 1);
    assert.equal(issue.denominators.agentDone, 0);
    assert.equal(issue.normalised.agentRuns, issue.totals.units);
  });

  test('an issue with no agent run says the denominator is unavailable rather than dividing by zero', () => {
    const quick = report.issues.find((entry) => entry.issue === 300);
    assert.equal(quick.normalised.agentRuns, null);
    assert.match(quick.denominators.unavailable.agentRuns, /no subagent transcript/);
  });

  test('a denominator that is not known is printed as unavailable, with the reason', () => {
    const text = format({ ...report, issue: 100, issues: [issue] });
    assert.match(text, /per requirement\s+unavailable: no requirements allocated/);
    assert.match(text, /per merged PR\s+unavailable/);
    assert.doesNotMatch(text, /Infinity|NaN/);
  });

  test('issues are grouped by route and never into one table', () => {
    assert.deepEqual(
      report.routes.map((group) => [group.route, group.issues]),
      [
        ['quickfix', [300]],
        ['standard', [100]],
      ],
    );
    assert.match(format(report), /routes\s+not comparable/);
  });

  test('prints the caveats, and recommends nothing', () => {
    const text = format(report);
    assert.match(text, /lockfiles and generated output included/);
    assert.match(text, /attribution\s+a call belongs to the issue of the nearest earlier journal entry within 6 h/);
    assert.doesNotMatch(text, /\b(should|recommend|reduce|too expensive|consider)\b/i);
  });

  test('comparison puts only issues new since the snapshot on the "after" side', () => {
    const later = build({
      scan: scanOf({
        calls: [
          call({ at: at(0.5), model: 'claude-opus-5', usage: opus }),
          call({ at: at(50.5), model: 'claude-opus-5', usage: { input: 0, cacheRead: 500, cacheWrite: 0, output: 0 } }),
        ],
      }),
      entries: [entry(0, 100, 'triaged'), entry(50, 400, 'triaged')],
      records: {
        100: { route: 'standard', tasks: 4, slices: 2 },
        400: { route: 'standard', tasks: 4, slices: 1 },
      },
    });

    const result = compare(report, later);
    assert.deepEqual(result.issuesAfter, [400]);
    const perTask = result.routes.find((group) => group.route === 'standard').rows.find((row) => row.metric === 'per task');
    // before: 4 Opus calls of 1000 cache-read = 4·100·5 = 2000 units over 4 tasks
    // after: one of 500 = 250 units over 4 tasks
    assert.equal(perTask.before, 500);
    assert.equal(perTask.after, 62.5);
    assert.equal(perTask.delta, -0.875);
  });
});

describe('reading transcripts', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-cost-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the project directory name replaces every non-alphanumeric character', () => {
    assert.equal(
      slugOf('/Users/Vlad/Workspace/RedHat/git/vzhukovs/podman-desktop'),
      '-Users-Vlad-Workspace-RedHat-git-vzhukovs-podman-desktop',
    );
  });

  test('one response written as several lines is one call, and subagents are read from their own files', async () => {
    const usage = { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 2 };
    const line = (id, block, extra = {}) =>
      JSON.stringify({
        timestamp: '2026-08-26T10:00:00.000Z',
        sessionId: 's1',
        message: { id, model: 'claude-opus-5', role: 'assistant', usage, content: [{ type: block }] },
        ...extra,
      });

    await writeFile(
      join(dir, 's1.jsonl'),
      [
        line('msg_1', 'thinking'),
        line('msg_1', 'text'),
        line('msg_1', 'tool_use'),
        'not json',
        JSON.stringify({ timestamp: '2026-08-26T10:01:00.000Z', isCompactSummary: true, sessionId: 's1' }),
        line('msg_2', 'text'),
        '',
      ].join('\n'),
    );
    await mkdir(join(dir, 's1', 'subagents'), { recursive: true });
    await writeFile(join(dir, 's1', 'subagents', 'agent-abc.jsonl'), `${line('msg_3', 'text', { isSidechain: true })}\n`);

    const scanned = await scan([dir]);
    assert.equal(scanned.calls.length, 3);
    assert.equal(scanned.duplicateLines, 2);
    assert.equal(scanned.unreadableLines, 1);
    assert.equal(scanned.compactions.length, 1);
    assert.equal(scanned.subagentFiles, 1);
    assert.deepEqual(scanned.calls.map((entry) => entry.agent).sort(), ['abc', null, null]);
  });

  test('a missing transcript directory is a skip with a reason, not an exception', async () => {
    const home = join(dir, 'home');
    const report = await collect({
      transcripts: [join(dir, 'does-not-exist')],
      config: {},
      home,
      sizeOf: async () => {
        throw new Error('not reached');
      },
    });

    assert.ok(report.skip);
    assert.match(report.skip.reason, /no transcripts at .*does-not-exist/);
    assert.equal(report.coverage, null);
    assert.match(format(report), /skip: no transcripts/);
  });
});

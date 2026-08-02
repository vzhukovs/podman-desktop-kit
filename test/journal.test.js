// SPDX-License-Identifier: Apache-2.0

// Contract for lib/journal.js.
//
// Two properties carry the weight. The line format is read by people and by
// the re-anchoring injection, so it is pinned literally against the example in
// section 2.3. And the module must have no way to remove an entry: a journal
// that can be rewritten answers "why did we do this" with whatever the last
// writer preferred.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as journal from '../lib/journal.js';

let home;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-journal-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the line format', () => {
  test('matches the example in section 2.3', () => {
    const line = journal.formatEntry({
      at: '2026-07-30T14:02:11Z',
      issue: 12345,
      slice: 2,
      event: 'plan-approved',
      detail: 'R1,R2,R3 frozen',
    });

    assert.match(line, /^2026-07-30T14:02:11Z\s+issue:12345\s+slice:2\s+event:plan-approved\s+R1,R2,R3 frozen$/);
  });

  test('an absent field is a placeholder, not a blank column', () => {
    const line = journal.formatEntry({
      at: '2026-07-31T09:12:44Z',
      issue: 12908,
      slice: null,
      event: 'route',
      detail: 'quickfix (14 lines, 2 files)',
    });

    assert.match(line, /issue:12908\s+—\s+event:route/);
  });

  test('round-trips through parseEntry', () => {
    const entry = { at: '2026-07-30T14:02:11Z', issue: 12345, slice: 2, event: 'plan-approved', detail: 'R1 frozen' };
    assert.deepEqual(journal.parseEntry(journal.formatEntry(entry)), entry);
  });

  // One entry, one line. A detail that carried a newline would split into a
  // second line that parses as prose and disappears from every filtered view.
  test('newlines in a detail are flattened', () => {
    const line = journal.formatEntry({
      at: '2026-07-30T14:02:11Z',
      issue: 1,
      slice: null,
      event: 'note',
      detail: 'first\nsecond',
    });

    assert.equal(line.includes('\n'), false);
    assert.equal(journal.parseEntry(line).detail, 'first second');
  });

  test('prose in the file is not an entry', () => {
    assert.equal(journal.parseEntry('# Journal'), null);
    assert.equal(journal.parseEntry(''), null);
  });
});

describe('append', () => {
  test('writes into the month file of the entry', async () => {
    await journal.append({ at: '2026-07-30T14:02:11Z', issue: 12345, event: 'plan-approved', detail: 'R1 frozen' }, { home });
    await journal.append({ at: '2026-08-02T10:00:00Z', issue: 12345, event: 'pr-open', detail: '#2871' }, { home });

    const july = await readFile(join(home, 'journal', '2026-07.md'), 'utf8');
    const august = await readFile(join(home, 'journal', '2026-08.md'), 'utf8');
    assert.match(july, /plan-approved/);
    assert.equal(july.includes('pr-open'), false);
    assert.match(august, /pr-open/);
  });

  test('never truncates what is already there', async () => {
    const before = await readFile(join(home, 'journal', '2026-07.md'), 'utf8');
    await journal.append({ at: '2026-07-30T15:00:00Z', issue: 999, event: 'note', detail: 'second' }, { home });
    const after = await readFile(join(home, 'journal', '2026-07.md'), 'utf8');

    assert.ok(after.startsWith(before), 'an append rewrote earlier content');
    assert.match(after, /second/);
  });

  // The invariant from section 2.2, checked against the module surface rather
  // than against intentions: if a remove ever appears, this fails.
  test('the module exports no way to remove an entry', () => {
    const surface = Object.keys(journal);
    for (const name of ['remove', 'delete', 'rewrite', 'clear', 'truncate', 'write']) {
      assert.equal(surface.includes(name), false, `journal exports "${name}"`);
    }
  });
});

describe('read', () => {
  test('filters by issue', async () => {
    const entries = await journal.read({ issue: 12345 }, { home });
    assert.deepEqual(
      entries.map((entry) => entry.event),
      ['plan-approved', 'pr-open'],
    );
  });

  test('filters by event', async () => {
    const entries = await journal.read({ event: 'note' }, { home });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].issue, 999);
  });

  test('since skips whole month files', async () => {
    const entries = await journal.read({ since: '2026-08' }, { home });
    assert.deepEqual(
      entries.map((entry) => entry.event),
      ['pr-open'],
    );
  });

  test('since is exact to the second inside a month', async () => {
    const entries = await journal.read({ since: '2026-07-30T14:30:00Z' }, { home });
    assert.deepEqual(
      entries.map((entry) => entry.detail),
      ['second', '#2871'],
    );
  });

  test('prose lines in a month file are skipped', async () => {
    await writeFile(join(home, 'journal', '2026-09.md'), '# September\n\nfree text\n');
    const entries = await journal.read({ since: '2026-09' }, { home });
    assert.deepEqual(entries, []);
  });

  test('no journal yet is an empty list, not an error', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pdkit-journal-'));
    assert.deepEqual(await journal.read({}, { home: empty }), []);
    await rm(empty, { recursive: true, force: true });
  });
});

// `--since` filters by string comparison against an ISO timestamp, and that
// detail used to reach the command line: `1h` sorted above every date so the
// whole journal came back, `24h` sorted below every date so nothing did. Two
// opposite wrong answers, neither of them an error.
describe('what --since accepts', () => {
  const { resolveSince } = journal;
  const NOW = Date.parse('2026-08-02T12:00:00Z');

  test('a date is taken as written', () => {
    assert.deepEqual(resolveSince('2026-08-01', NOW), { ok: true, at: '2026-08-01' });
    assert.deepEqual(resolveSince('2026-08-01T09:30:00Z', NOW), { ok: true, at: '2026-08-01T09:30:00Z' });
  });

  test('an age becomes the timestamp it means', () => {
    assert.equal(resolveSince('2h', NOW).at, '2026-08-02T10:00:00Z');
    assert.equal(resolveSince('90m', NOW).at, '2026-08-02T10:30:00Z');
    assert.equal(resolveSince('7d', NOW).at, '2026-07-26T12:00:00Z');
    assert.equal(resolveSince('1w', NOW).at, '2026-07-26T12:00:00Z');
  });

  // The two that were wrong, now right, and in opposite directions from before.
  test('the two that used to answer wrongly now answer', () => {
    assert.equal(resolveSince('1h', NOW).at, '2026-08-02T11:00:00Z');
    assert.equal(resolveSince('24h', NOW).at, '2026-08-01T12:00:00Z');
  });

  test('anything else is refused by name rather than compared as text', () => {
    for (const bad of ['yesterday', '24', 'last week', '', 'tomorrow', '2h ago']) {
      const result = resolveSince(bad, NOW);
      assert.equal(result.ok, false, `${bad} should not be accepted`);
      assert.match(result.error, /expected a date .* or an age/);
    }
  });
});

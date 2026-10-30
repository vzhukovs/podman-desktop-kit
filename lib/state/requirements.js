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

// Requirement sets as values: what an amendment does to one, computed without
// reading or writing anything. Storing the result is lib/state.js's, which
// re-exports this file under the names callers know.

/** The number of an R-ID. */
const numberOf = (id) => Number.parseInt(id.slice(1), 10);

/**
 * What an amendment's requirement table does to a requirement set, computed and
 * not written.
 *
 * Separate from amendRequirements so `amendment approve` can ask before it
 * rewrites the amendment's status: an amendment recorded as approved whose
 * table then turns out not to apply is a decision on disk that the record
 * contradicts, and the cheapest way not to produce one is to refuse first.
 *
 * The rules are the ones the template's comment states. A withdrawn, superseded
 * or replaced R-ID leaves the live set and keeps its number — nothing is ever
 * renumbered. An added one continues the numbering from `next`, with no gap and
 * no reuse: an R-ID that was ever allocated means that requirement forever,
 * including after it was withdrawn. A requirement given way to (`superseded by
 * R8`) has to be in the set the amendment produces, or the sentence points at
 * nothing.
 *
 * `reflected` is the set already saying what the table says — every added ID
 * present, every removed one gone. That is what an amendment applied by hand
 * looks like (18915, A1, through `node -e`), and applying it again would refuse
 * on its own added IDs.
 *
 * @param {{ids: string[], next: number}} requirements
 * @param {Array<import('../artefacts.js').RequirementChange>} rows
 * @returns {{ok: boolean, problems: string[], before: string[], after: string[], next: number, added: string[], removed: string[], reflected: boolean}}
 */
export function amendedRequirements(requirements, rows) {
  const before = [...(requirements.ids ?? [])];
  const next = requirements.next ?? 1;
  const problems = [];
  const outcome = (fields) => ({ ok: problems.length === 0, problems, before, after: before, next, added: [], removed: [], reflected: false, ...fields });

  for (const row of rows) {
    if (row.problem) problems.push(`line ${row.line}: ${row.problem}`);
  }
  if (problems.length > 0) return outcome();

  const named = new Map();
  for (const row of rows) {
    for (const id of row.ids) {
      if (named.has(id)) problems.push(`line ${row.line}: ${id} is already on line ${named.get(id)} — one row per requirement`);
      else named.set(id, row.line);
    }
  }

  const of = (...kinds) => rows.filter((row) => kinds.includes(row.change)).flatMap((row) => row.ids);
  const added = of('added').sort((a, b) => numberOf(a) - numberOf(b));
  const removed = of('withdrawn', 'superseded', 'replaced').sort((a, b) => numberOf(a) - numberOf(b));
  const unchanged = of('unchanged');

  const reflected =
    problems.length === 0 &&
    added.length + removed.length > 0 &&
    added.every((id) => before.includes(id) && numberOf(id) < next) &&
    // Gone because it was allocated and taken out, not because it never was.
    removed.every((id) => !before.includes(id) && numberOf(id) < next) &&
    unchanged.every((id) => before.includes(id));
  if (reflected) return outcome({ reflected: true, added, removed });

  for (const row of rows) {
    if (row.change === 'added') continue;
    for (const id of row.ids) {
      if (!before.includes(id)) problems.push(`line ${row.line}: ${id} is "${row.wrote}", and the issue's live set (${before.join(', ') || 'empty'}) has no ${id}`);
    }
  }

  // Numbering continues from the counter: the first added ID is `next`, and
  // each one after it is the one after that.
  for (const [index, id] of added.entries()) {
    const expected = `R${next + index}`;
    if (id === expected) continue;
    problems.push(
      numberOf(id) < next
        ? `${id} is added, and R1 to R${next - 1} were allocated already — an R-ID means one requirement forever, including after it is withdrawn`
        : `${id} is added where ${expected} comes next — new R-IDs continue the numbering without a gap`,
    );
    break;
  }

  const after = [...before.filter((id) => !removed.includes(id)), ...added];
  for (const row of rows) {
    if (!row.by) continue;
    if (row.ids.includes(row.by)) problems.push(`line ${row.line}: ${row.by} cannot be ${row.wrote.toLowerCase()} itself`);
    else if (!after.includes(row.by)) {
      problems.push(`line ${row.line}: ${row.ids.join(', ')} gives way to ${row.by}, which is not in the set this amendment produces`);
    }
  }

  if (problems.length > 0) return outcome();
  return outcome({ after, next: next + added.length, added, removed });
}

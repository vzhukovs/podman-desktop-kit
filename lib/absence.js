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

// What a claim that something is not there looks like in prose, and whether
// it says how that was established.
//
// A positive claim is checked by its location: `file:line`, and anyone can go
// and look. A negative claim has no location, so the same rule lets it pass
// without one, and "not found" written as "not there" is how a cut read or a
// borrowed name becomes a fact. What stands in for the location is the search:
// `searched: <query> in <where> -> 0`.
//
// A negative claim scoped to a place keeps its location: "`store.ts:54-59`
// has no conversion" is checked by reading those lines, and plans are full of
// them. What has nothing behind it is the negative claim about the codebase or
// an API as a whole, which cites neither. Requiring a search of every negative
// line refused 12 of 22 real plans, almost all for located claims; requiring it
// of the unlocated ones leaves the claims that a cut read or a borrowed name
// produces.
//
// One owner for the wording, because two places read it: the plan check
// refuses an unsearched absence in a plan's Context, and the post-claim hook
// reminds about one in any markdown written. Two copies of these patterns
// would disagree about what counts within a release.
//
// Facts only: which lines match. Whether a match is a real claim is for the
// author, who either adds the search or rewords the line.

/** Wording that says a thing is not there. */
const ABSENCE = [
  /\b(?:missing|lacks?|lacking|absent|has no|have no|there is no|there are no|no such)\b/i,
  /\b(?:does(?:n't| not)|do(?:n't| not)) (?:exist|have|expose|provide|support|handle)\b/i,
  /\b(?:is|are)(?:n't| not) (?:exposed|available|supported|present|implemented|handled|there)\b/i,
];

/** Wording that proposes adding a thing, which claims it is not there yet. */
const PROPOSAL = [
  /\b(?:add|adds|adding|added|introduce[sd]?|introducing|new|expose[sd]?|exposing)\b/i,
];

/*
 * A question about adding a thing carries the claim that it is not there yet,
 * and a question is the one form nobody marks as checked. Two halves: the
 * sentence is a question, and what it asks about is a need or an addition.
 * "whether to add" alone was caught before; "do we need" and "is it worth"
 * were not, and the same premise can go through in those forms.
 */
const QUESTION = [/\bwhether\b/i, /\?\s*$/];
const NEED = [/\b(?:need|needs|needed|worth|should)\b/i];

/*
 * The search a negative claim cites in place of a location: what was run and
 * that it came back empty. "searched: yes" names neither, and a form that one
 * word satisfies is a form nobody has to fill. Where is not required on its
 * own: it is usually inside the query (`git grep -i x packages/api`), and a
 * literal "in" would refuse those.
 */
const SEARCHED = /\bsearched:\s*\S.*?(?:->|→)\s*0(?!\d)/i;

/** A location: `file.ts:54`, `file.ts:54-59`, or a bare `:54` after one. */
const LOCATION = /[\w./-]+\.[A-Za-z]\w*`?:\d+|(?:^|[\s(`])(?::\d+)/;

/**
 * Whether the text says something is not there.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function saysAbsent(text) {
  return ABSENCE.some((pattern) => pattern.test(text));
}

/**
 * Whether the text proposes adding something.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function proposesAdding(text) {
  return PROPOSAL.some((pattern) => pattern.test(text));
}

/**
 * Whether the text asks if a thing is needed or should be added: a question
 * whose premise is that the thing is not there.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function asksWhetherToAdd(text) {
  const question = QUESTION.some((pattern) => pattern.test(text));
  return question && (NEED.some((pattern) => pattern.test(text)) || proposesAdding(text));
}

/**
 * Whether the text names the search a negative claim rests on.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function citesSearch(text) {
  return SEARCHED.test(text);
}

/**
 * Whether the text cites a place in the code.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function citesLocation(text) {
  return LOCATION.test(text);
}

/**
 * Lines that say something is absent and cite neither a location nor a
 * search, with their 1-based line numbers. Blank lines and headings are
 * skipped; a heading states a topic, not a finding.
 *
 * @param {string} text
 * @returns {{line: number, text: string}[]}
 */
export function unsearched(text) {
  const found = [];
  String(text ?? '')
    .split('\n')
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      if (saysAbsent(trimmed) && !citesSearch(trimmed) && !citesLocation(trimmed)) found.push({ line: index + 1, text: trimmed });
    });
  return found;
}

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

// Preflight check: a merge order in the body that the graph does not have
//
// Every one of the three pull requests on DESKTOP-19818 said "merge #19829 →
// #19830 → #19831", and the graph said #19829 and #19830 were independent.
// Both were true in their own way: the order was real, and the dependency
// that made it real was a runtime contract no build had seen. Upstream's
// answer was that a pull request which only works if a human merges it in
// the right order is not acceptable, because main is broken in between.
//
// So an order stated in a body is read as a claim about dependency, and held
// against the graph. A stack is an order the graph knows, and passes. Anything
// else is a dependency nobody verified and nobody can enforce.

import { dependentsOf } from '../../slice.js';

/** @type {string} */
export const id = 'merge-order';

/** @type {boolean} */
export const blocking = true;

/** @type {boolean} */
export const needsBody = true;

/** A pull request, by number or by link. */
const REF = /https?:\/\/github\.com\/[^\s)\]]*?\/pull\/(\d+)|#(\d+)/g;

/** `a → b`, and the ASCII ways of writing it. */
const ARROW = /^\s*(?:→|->|=>)\s*$/;

/** Prose that puts another pull request before this one. */
const BEFORE_THIS = [
  /\bafter\s+#(\d+)\s+(?:merges|lands|is merged)/gi,
  /\b(?:depends on|requires|needs)\s+#(\d+)/gi,
  /\bmerge\s+#(\d+)\s+first\b/gi,
];

/**
 * Orders a body states, as pairs of pull request numbers.
 *
 * `this` stands for the pull request the body belongs to, which has no number
 * yet on the first pass.
 *
 * @param {string} body
 * @returns {Array<{first: number, then: number|'this'}>}
 */
export function orderClaims(body) {
  const text = String(body ?? '');
  const refs = [...text.matchAll(REF)].map((match) => ({
    number: Number(match[1] ?? match[2]),
    start: match.index,
    end: match.index + match[0].length,
  }));

  const claims = [];
  for (let at = 1; at < refs.length; at += 1) {
    if (ARROW.test(text.slice(refs[at - 1].end, refs[at].start))) {
      claims.push({ first: refs[at - 1].number, then: refs[at].number });
    }
  }

  for (const pattern of BEFORE_THIS) {
    for (const match of text.matchAll(pattern)) claims.push({ first: Number(match[1]), then: 'this' });
  }

  return claims;
}

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const graph = context.sliceGraph;
  if (!graph || graph.slices.length < 2) {
    return { id, status: 'skip', blocking, summary: 'one pull request for this issue: there is nothing to order' };
  }
  if (context.prBody === null || context.prBody === undefined) {
    return { id, status: 'skip', blocking, summary: 'no body yet; this runs on the second pass' };
  }

  const claims = orderClaims(context.prBody);
  if (claims.length === 0) return { id, status: 'pass', blocking, summary: 'the body states no merge order' };

  const sliceOf = (number) => {
    if (number === 'this') return context.sliceRecord?.index ?? null;
    return graph.slices.find((slice) => slice.pr === number)?.index ?? null;
  };

  const hidden = [];
  for (const claim of claims) {
    const first = sliceOf(claim.first);
    const then = sliceOf(claim.then);
    // A number that is not one of this issue's slices is somebody else's
    // pull request, and an order against it is not this graph's business.
    if (first === null || then === null || first === then) continue;
    if (!dependentsOf(graph, first).includes(then)) hidden.push({ claim, first, then });
  }

  if (hidden.length === 0) {
    return { id, status: 'pass', blocking, summary: `${claims.length} stated order(s), each one a stack the graph has` };
  }

  const named = hidden
    .map(({ claim, first, then }) => `#${claim.first} (slice #${first}) before ${claim.then === 'this' ? 'this one' : `#${claim.then}`} (slice #${then})`)
    .join('; ');

  return {
    id,
    status: 'fail',
    blocking,
    summary: `the body orders ${named}, and the graph has no dependency between them`,
    remedy:
      'an order upstream has to follow by hand is a dependency main is broken without. Put those slices in one ' +
      '(per-layer commits keep them apart for review: pdkit slice join), or stack them and verify again. If the ' +
      'order is only a preference, take it out of the body',
  };
}

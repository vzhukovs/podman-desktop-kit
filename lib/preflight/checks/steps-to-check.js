// SPDX-License-Identifier: Apache-2.0

// Preflight check: steps to check
//
// At least three numbered steps, each with an expected result. This holds on
// the quickfix route too: a small change does not make a reviewer better at
// guessing what they are looking for.
//
// What is being defended is a reviewer's time. "Test the dialog" is not a
// step; "open Settings → the dialog appears once" is.

/** @type {string} */
export const id = 'steps-to-check';

/** @type {boolean} */
export const blocking = true;

/**
 * The upstream template's heading for this section.
 *
 * Bounded by the next `###` heading **or the next bold sub-heading**. Without
 * the second, the section swallows "Notes for reviewers" and the template's
 * own task-list checkbox, and both were then counted as steps that state no
 * expected result — a check failing a body it had itself produced.
 */
const SECTION = /###\s*How to test this PR\?([\s\S]*?)(?=\n###\s|\n\*\*|\n*$)/i;

/**
 * `1. …` or `2) …`. Numbered only: a bullet in this section is a note, and the
 * template's `- [ ] Tests are covering…` is a checkbox rather than a step.
 */
const STEP = /^\s*\d+[.)]\s+\S/;

/** An expected result: an arrow, "should", "expect", or a → in prose. */
const EXPECTATION = /→|->|\bshould\b|\bexpect(?:ed|s)?\b|\bappears?\b|\bpasses?\b|\bshows?\b/i;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.prBody === null) {
    return {
      id,
      status: 'skip',
      blocking,
      summary: 'the PR body is not drafted yet',
      remedy: 'draft the body, then run preflight again — this check has to read it',
    };
  }

  const section = SECTION.exec(context.prBody);
  if (!section) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'the body has no "How to test this PR?" section',
      remedy: 'it is one of the four sections of the repository PR template, and reviewers look for it',
    };
  }

  const steps = section[1].split('\n').filter((line) => STEP.test(line));
  if (steps.length < 3) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${steps.length} step${steps.length === 1 ? '' : 's'}, at least 3 are required`,
      remedy: 'build, run, observe, and one regression check is the usual minimum. This applies on the quickfix route too',
    };
  }

  const vague = steps.filter((step) => !EXPECTATION.test(step));
  if (vague.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${vague.length} step${vague.length === 1 ? ' states no' : 's state no'} expected result`,
      output: vague.join('\n'),
      remedy: 'each step is an action and what should happen: "Settings → Appearance → the dropdown lists High contrast dark"',
    };
  }

  return { id, status: 'pass', blocking, summary: `${steps.length} steps, each with an expected result` };
}

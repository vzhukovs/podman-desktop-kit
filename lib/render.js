// SPDX-License-Identifier: Apache-2.0

// Rendering templates/*.md into the artefacts under $PDKIT_HOME.
//
// Templates are the shape of an artefact; this module fills them. Keeping the
// shape in a file rather than in a prompt means a missing section is a diff,
// not a matter of whether the model remembered it this time.

/** Templates shipped with the plugin, by artefact name. */
export const TEMPLATES = {
  issue: 'issue.md',
  plan: 'plan.md',
  task: 'task.md',
  receipt: 'receipt.md',
  slices: 'slices.md',
  prBody: 'pr-body.md',
  reviewReport: 'review-report.md',
  planAmendment: 'plan-amendment.md',
};

/**
 * Render a template with the given values.
 *
 * @param {keyof TEMPLATES} _template
 * @param {Record<string, unknown>} _values
 * @returns {Promise<string>}
 */
export async function render(_template, _values) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Render and write an artefact into $PDKIT_HOME/issues/<n>/.
 *
 * @param {{issue: number, template: keyof TEMPLATES, path: string, values: Record<string, unknown>}} _input
 * @returns {Promise<string>} the path written
 */
export async function write(_input) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

/**
 * Check a rendered artefact still has every section its template declares.
 * Catches the case where an agent rewrote a file and dropped a section.
 *
 * @param {keyof TEMPLATES} _template
 * @param {string} _content
 * @returns {Promise<{ok: boolean, missing: string[]}>}
 */
export async function validateSections(_template, _content) {
  // TODO(stage 2)
  throw new Error('not implemented');
}

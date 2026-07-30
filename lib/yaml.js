// SPDX-License-Identifier: Apache-2.0

// Reader for the subset of YAML the pdkit config uses.
//
// Node has no YAML in its standard library and this plugin ships zero
// dependencies, so the subset is deliberate and small:
//
//   supported     nested maps, block sequences, inline sequences [a, b],
//                 strings, numbers, booleans, null, quotes, # comments
//   NOT supported anchors and aliases, multiline scalars (| and >), tags,
//                 multi-document files, complex keys
//
// Anything outside the subset raises a parse error. It never degrades
// silently: a config that looks parsed but lost a key is worse than one that
// refuses to load, because the loss surfaces later as a wrong gate decision.

/** @typedef {Record<string, unknown>} YamlMap */

export class YamlError extends Error {
  /**
   * @param {string} message
   * @param {number} line 1-based line number
   */
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

/**
 * Parse a YAML document from the supported subset.
 *
 * @param {string} _source
 * @returns {YamlMap}
 * @throws {YamlError} on anything outside the subset
 */
export function parse(_source) {
  // TODO(stage 0): tokenize by indentation, then build maps and sequences.
  throw new Error('not implemented');
}

/**
 * Serialize a value back to the supported subset. Used to write the default
 * config into $PDKIT_HOME on `pdkit init`.
 *
 * @param {YamlMap} _value
 * @returns {string}
 */
export function stringify(_value) {
  // TODO(stage 0)
  throw new Error('not implemented');
}

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
//
// One deliberate departure from YAML 1.1: `on`, `off`, `yes` and `no` stay
// strings. The config uses them as enum members next to `auto`
// (`rtk.enabled: auto | on | off`), and a reader that turned two of the three
// into booleans would hand consumers a field with two different types.

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
 * Strip a trailing comment, respecting quotes.
 *
 * A `#` only starts a comment at the beginning of the line or after
 * whitespace — `a: x#y` is the string `x#y`, and every path in
 * `forbid_paths` depends on that.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }

  return text;
}

/**
 * Turn the source into significant lines: indentation, content, line number.
 * Blank lines and comments are dropped here so no later stage has to know
 * about them.
 *
 * @param {string} source
 * @returns {Array<{indent: number, content: string, line: number}>}
 */
function scan(source) {
  const lines = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();

    if (trimmed === '---' || trimmed === '...') {
      throw new YamlError('multi-document files are not supported', line);
    }

    const content = stripComment(raw).trimEnd();
    if (content.trim() === '') return;

    const indent = content.length - content.trimStart().length;
    if (/^[^\S\n]*\t/.test(content)) {
      throw new YamlError('tabs are not valid indentation', line);
    }

    lines.push({ indent, content: content.trimStart(), line });
  });

  return lines;
}

/**
 * Index of the `:` that separates a key from its value, or -1.
 *
 * The colon has to be followed by whitespace or end of line; without that
 * rule `upstream_remote: https://example` would split inside the URL.
 *
 * @param {string} content
 * @returns {number}
 */
function keySeparator(content) {
  let quote = null;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ':' && (i === content.length - 1 || /\s/.test(content[i + 1]))) {
      return i;
    }
  }

  return -1;
}

/**
 * Split the inside of a flow sequence on commas that are not nested or quoted.
 *
 * @param {string} body
 * @param {number} line
 * @returns {string[]}
 */
function splitFlow(body, line) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';

  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (quote) throw new YamlError('unterminated quote', line);
  if (depth !== 0) throw new YamlError('unterminated inline sequence', line);
  if (current.trim() !== '' || parts.length > 0) parts.push(current);

  return parts.map((part) => part.trim());
}

/**
 * Parse an inline sequence: `[a, b]`.
 *
 * @param {string} text
 * @param {number} line
 * @returns {unknown[]}
 */
function parseFlowSequence(text, line) {
  if (!text.endsWith(']')) {
    throw new YamlError('inline sequences must close on the same line', line);
  }
  return splitFlow(text.slice(1, -1), line).map((item) => {
    if (item === '') throw new YamlError('empty item in an inline sequence', line);
    return parseValue(item, line);
  });
}

/**
 * Parse a quoted or plain scalar.
 *
 * @param {string} text already trimmed
 * @param {number} line
 * @returns {unknown}
 */
function parseScalar(text, line) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    if (text.length < 2 || !text.endsWith(quote)) {
      throw new YamlError('unterminated quote', line);
    }
    const body = text.slice(1, -1);
    return quote === '"' ? body.replace(/\\(["\\ntr])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c) : body.replaceAll("''", "'");
  }

  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?(\d+\.\d*|\.\d+)$/.test(text)) return Number.parseFloat(text);

  return text;
}

/**
 * Parse anything that can appear to the right of a key on the same line.
 * This is where the subset is enforced: the constructs below are recognised
 * only well enough to refuse them by name.
 *
 * @param {string} text already trimmed, non-empty
 * @param {number} line
 * @returns {unknown}
 */
function parseValue(text, line) {
  if (text.startsWith('[')) return parseFlowSequence(text, line);
  if (text.startsWith('{')) throw new YamlError('inline maps are not supported', line);
  if (text === '|' || text === '>' || text.startsWith('| ') || text.startsWith('> ') || /^[|>][-+\d]/.test(text)) {
    throw new YamlError('multiline scalars (| and >) are not supported', line);
  }
  if (text.startsWith('&')) throw new YamlError('anchors are not supported', line);
  if (text.startsWith('*')) throw new YamlError('aliases are not supported', line);
  if (text.startsWith('!')) throw new YamlError('tags are not supported', line);

  return parseScalar(text, line);
}

/**
 * Parse a block at a known indentation. Returns the value and the index of
 * the first line that does not belong to it.
 *
 * @param {ReturnType<typeof scan>} lines
 * @param {number} start
 * @param {number} indent
 * @returns {[unknown, number]}
 */
function parseBlock(lines, start, indent) {
  const first = lines[start];

  // A flow sequence written under its key rather than beside it — the shape
  // `never_rewrite:` uses in the shipped config to stay inside 100 columns.
  if (first.content.startsWith('[')) {
    return [parseFlowSequence(first.content, first.line), start + 1];
  }
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSequence(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

/**
 * @param {ReturnType<typeof scan>} lines
 * @param {number} start
 * @param {number} indent
 * @returns {[unknown[], number]}
 */
function parseSequence(lines, start, indent) {
  const result = [];
  let index = start;

  while (index < lines.length && lines[index].indent === indent) {
    const { content, line } = lines[index];
    if (content !== '-' && !content.startsWith('- ')) break;

    const rest = content.slice(1).trim();

    if (rest === '') {
      const next = lines[index + 1];
      if (next && next.indent > indent) {
        const [value, after] = parseBlock(lines, index + 1, next.indent);
        result.push(value);
        index = after;
        continue;
      }
      result.push(null);
      index += 1;
      continue;
    }

    if (keySeparator(rest) !== -1) {
      throw new YamlError('maps inside sequence entries are not supported', line);
    }

    result.push(parseValue(rest, line));
    index += 1;
  }

  if (index < lines.length && lines[index].indent > indent) {
    throw new YamlError('unexpected indentation', lines[index].line);
  }

  return [result, index];
}

/**
 * @param {ReturnType<typeof scan>} lines
 * @param {number} start
 * @param {number} indent
 * @returns {[YamlMap, number]}
 */
function parseMap(lines, start, indent) {
  /** @type {YamlMap} */
  const result = {};
  let index = start;

  while (index < lines.length && lines[index].indent === indent) {
    const { content, line } = lines[index];

    if (content === '-' || content.startsWith('- ')) {
      throw new YamlError('sequence entry where a key was expected', line);
    }

    const separator = keySeparator(content);
    if (separator === -1) throw new YamlError('expected "key: value"', line);

    const key = parseScalar(content.slice(0, separator).trim(), line);
    if (typeof key !== 'string') throw new YamlError('keys must be strings', line);

    const rest = content.slice(separator + 1).trim();

    if (rest === '') {
      const next = lines[index + 1];
      if (next && next.indent > indent) {
        const [value, after] = parseBlock(lines, index + 1, next.indent);
        result[key] = value;
        index = after;
        continue;
      }
      result[key] = null;
      index += 1;
      continue;
    }

    result[key] = parseValue(rest, line);
    index += 1;
  }

  if (index < lines.length && lines[index].indent > indent) {
    throw new YamlError('unexpected indentation', lines[index].line);
  }

  return [result, index];
}

/**
 * Parse a YAML document from the supported subset.
 *
 * @param {string} source
 * @returns {YamlMap}
 * @throws {YamlError} on anything outside the subset
 */
export function parse(source) {
  const lines = scan(source);
  if (lines.length === 0) return {};

  const [value, index] = parseBlock(lines, 0, lines[0].indent);
  if (index < lines.length) {
    throw new YamlError('unexpected content after the document', lines[index].line);
  }

  return /** @type {YamlMap} */ (value);
}

/**
 * Quote a string when leaving it bare would change what it parses back to.
 *
 * @param {string} text
 * @returns {string}
 */
function quoteIfNeeded(text) {
  const ambiguous =
    text === '' ||
    text !== text.trim() ||
    /^[-&*!|>[{#]/.test(text) ||
    /:\s|\s#/.test(text) ||
    text.endsWith(':') ||
    ['true', 'false', 'null', '~'].includes(text) ||
    /^-?(\d+|\d*\.\d+)$/.test(text);

  return ambiguous ? `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : text;
}

/**
 * Serialize a value back to the supported subset. Used where a config has to
 * be written rather than copied; `pdkit init` copies `defaults/config.yaml`
 * verbatim instead, because the comments in that file carry decisions.
 *
 * @param {YamlMap} value
 * @returns {string}
 */
export function stringify(value) {
  /**
   * @param {unknown} node
   * @param {number} depth
   * @returns {string[]}
   */
  function emit(node, depth) {
    const pad = '  '.repeat(depth);
    const lines = [];

    for (const [key, item] of Object.entries(/** @type {YamlMap} */ (node))) {
      if (Array.isArray(item)) {
        lines.push(`${pad}${quoteIfNeeded(key)}:`);
        for (const entry of item) {
          if (entry !== null && typeof entry === 'object') {
            throw new TypeError('stringify: sequences of maps are outside the subset');
          }
          lines.push(`${pad}  - ${scalar(entry)}`);
        }
        continue;
      }

      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}${quoteIfNeeded(key)}:`);
        lines.push(...emit(item, depth + 1));
        continue;
      }

      lines.push(`${pad}${quoteIfNeeded(key)}: ${scalar(item)}`);
    }

    return lines;
  }

  /**
   * @param {unknown} item
   * @returns {string}
   */
  function scalar(item) {
    if (item === null || item === undefined) return 'null';
    if (typeof item === 'string') return quoteIfNeeded(item);
    if (typeof item === 'number' || typeof item === 'boolean') return String(item);
    throw new TypeError(`stringify: unsupported value type "${typeof item}"`);
  }

  return `${emit(value, 0).join('\n')}\n`;
}

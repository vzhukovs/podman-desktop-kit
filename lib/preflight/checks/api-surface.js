// SPDX-License-Identifier: Apache-2.0

// Preflight check: API-surface grep
//
// The RunOptions trap, codified. RunOptions lives in
// packages/main/src/plugin/util/exec.ts and reads as an internal helper, while
// also being declared in extension-api.d.ts — which makes it public API, with
// backward-compatibility obligations nobody thought they were taking on.
//
// This is a grep, not a judgement call, and that is exactly why it belongs in
// preflight rather than in a prompt: an agent asked to "consider whether this
// is public API" will consider it and be wrong.

import { capture } from '../../evidence.js';
import { EXTENSION_API_DTS, classifyApiSurface } from '../../upstream.js';

/** @type {string} */
export const id = 'api-surface';

/** @type {boolean} */
export const blocking = true;

/** `export interface Foo`, `export type Foo`, `export class Foo`… in a diff. */
const EXPORTED = /^\+\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum|function|const|namespace)\s+([A-Za-z_$][\w$]*)/;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const sources = context.changedFiles.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  if (sources.length === 0) {
    return { id, status: 'skip', blocking, summary: 'the diff adds no TypeScript exports' };
  }

  // The added lines only: a symbol that was already exported and already
  // public is not news, and reporting it every run teaches people to ignore
  // this check.
  const diff = await capture({
    command: `git diff ${context.base}...${context.ref} -- ${sources.map((file) => `'${file}'`).join(' ')}`,
    cwd: context.repoRoot,
  });

  const symbols = new Set();
  for (const line of diff.stdout.split('\n')) {
    const match = EXPORTED.exec(line);
    if (match) symbols.add(match[1]);
  }

  if (symbols.size === 0) {
    return { id, status: 'skip', blocking, summary: 'the diff adds no exported symbols' };
  }

  const classified = await classifyApiSurface({ symbols: [...symbols], repoRoot: context.repoRoot });
  const publicOnes = classified.filter((entry) => entry.public);

  if (publicOnes.length > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${publicOnes.length} changed symbol${publicOnes.length === 1 ? ' is' : 's are'} part of the public extension API`,
      output: publicOnes.map((entry) => `${entry.symbol} — declared at ${entry.declaredAt}`).join('\n'),
      remedy: `this is public API, not an internal helper: keep it backward compatible, say what happens to existing extensions, and cover disposal. ${EXTENSION_API_DTS} is where a reviewer will look`,
    };
  }

  return {
    id,
    status: 'pass',
    blocking,
    summary: `${symbols.size} exported symbol${symbols.size === 1 ? '' : 's'} added, none in the public surface`,
  };
}

// SPDX-License-Identifier: Apache-2.0

// Argument parsing, command dispatch, and exit codes for pdkit.
//
// Every command returns an exit code. Nothing here calls process.exit()
// directly: bin/pdkit sets process.exitCode so pending stdout flushes first.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(LIB_DIR, '..');

/**
 * Exit codes. BLOCK is the one the hook protocol cares about: a hook that
 * exits 2 stops the tool call and feeds stderr back to the model.
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  BLOCK: 2,
};

/** Hook events registered in hooks/hooks.json, mapped to their handler module. */
const HOOK_HANDLERS = {
  'pre-bash': 'dispatch.js',
  'pre-write': 'owns.js',
  'post-write': 'post-write.js',
  'task-completed': 'task-completed.js',
  'session-start': 'session-start.js',
  'pre-compact': 'session-start.js',
};

const USAGE = `pdkit — deterministic helper for the Podman Desktop Kit plugin

Usage:
  pdkit <command> [options]

Commands:
  doctor              check the environment and report what is missing
  hook <event>        run a hook handler; reads the hook payload on stdin
  version             print the plugin version

Options:
  --json              machine-readable output where supported
  -h, --help          show this help

Not implemented yet: init, issue, plan, slice, preflight, gate, pr, journal.
See specs/podman-desktop-kit-architecture.md section 12 for the delivery order.
`;

/**
 * Split argv into a command, positional arguments, and flags.
 *
 * @param {string[]} argv
 * @returns {{command: string|undefined, args: string[], flags: Record<string, string|boolean>}}
 */
export function parseArgs(argv) {
  const args = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      args.push(token);
      continue;
    }
    const [name, inlineValue] = token.replace(/^--?/, '').split('=');
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
      flags[name] = argv[i + 1];
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command: args.shift(), args, flags };
}

/** Read the plugin version from package.json. */
async function readVersion() {
  const raw = await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

/** Read a hook payload from stdin. Returns null when stdin is empty or not JSON. */
async function readHookPayload() {
  if (process.stdin.isTTY) return null;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Run a hook handler.
 *
 * Fails open on purpose. A hook that cannot load must not block the user's
 * work — the gate is enforced by handlers that are present and working, and a
 * missing module is a plugin bug, not a policy decision. The one thing this
 * must never do is silently allow when a handler *did* load and said BLOCK.
 */
async function runHook(event) {
  const handlerFile = HOOK_HANDLERS[event];
  if (!handlerFile) {
    process.stderr.write(`pdkit: unknown hook event "${event}"\n`);
    return EXIT.ERROR;
  }

  const payload = await readHookPayload();

  let handler;
  try {
    ({ handle: handler } = await import(join(LIB_DIR, 'hooks', handlerFile)));
  } catch (error) {
    process.stderr.write(`pdkit: hook handler "${handlerFile}" unavailable (${error.code ?? 'error'}); allowing\n`);
    return EXIT.OK;
  }

  if (typeof handler !== 'function') return EXIT.OK;

  let result;
  try {
    result = await handler(payload, { event, pluginRoot: PLUGIN_ROOT });
  } catch (error) {
    // Same reasoning as a missing module: a handler that throws is a plugin
    // bug. Blocking on it would make every Bash call fail while a stage is
    // half-built, and a gate people disable is worse than one that is honest
    // about being incomplete. The failure is reported, never swallowed.
    process.stderr.write(`pdkit: hook "${event}" failed (${error.message}); allowing\n`);
    return EXIT.OK;
  }

  if (result?.block) {
    process.stderr.write(`${result.reason ?? 'blocked by pdkit'}\n`);
    return EXIT.BLOCK;
  }
  if (result?.message) process.stdout.write(`${result.message}\n`);
  return EXIT.OK;
}

/** Environment check. Stub: reports that the real checks are not implemented. */
async function runDoctor(flags) {
  const report = {
    plugin: 'pd',
    version: await readVersion(),
    pluginRoot: PLUGIN_ROOT,
    node: process.version,
    status: 'stub',
    note: 'Environment checks are not implemented yet (stage 0, section 12).',
  };

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT.OK;
  }

  process.stdout.write(
    `pdkit ${report.version}\n` +
      `  plugin root : ${report.pluginRoot}\n` +
      `  node        : ${report.node}\n` +
      `  status      : ${report.status} — ${report.note}\n`,
  );
  return EXIT.OK;
}

/**
 * Entry point.
 *
 * @param {string[]} argv arguments after the executable name
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const { command, args, flags } = parseArgs(argv);

  if (flags.help || flags.h || (!command && !flags.version)) {
    process.stdout.write(USAGE);
    return command ? EXIT.OK : EXIT.ERROR;
  }

  if (flags.version || command === 'version') {
    process.stdout.write(`${await readVersion()}\n`);
    return EXIT.OK;
  }

  switch (command) {
    case 'doctor':
      return runDoctor(flags);
    case 'hook':
      if (!args[0]) {
        process.stderr.write('pdkit: hook requires an event name\n');
        return EXIT.ERROR;
      }
      return runHook(args[0]);
    default:
      process.stderr.write(`pdkit: unknown command "${command}"\n\n${USAGE}`);
      return EXIT.ERROR;
  }
}

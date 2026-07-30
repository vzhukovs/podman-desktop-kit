// SPDX-License-Identifier: Apache-2.0

// The wiring between hooks/hooks.json and the handler modules.
//
// Kept in its own file because two places need it and neither should own it:
// lib/cli.js dispatches on it, and the doctor checks hooks.json against it.
// A second copy would let the manifest and the dispatcher disagree, and the
// symptom of that disagreement is a hook that silently never runs.

/** Hook event name, as passed to `pdkit hook <event>`, mapped to its module. */
export const HOOK_HANDLERS = {
  'pre-bash': 'dispatch.js',
  'pre-write': 'owns.js',
  'post-write': 'post-write.js',
  'task-completed': 'task-completed.js',
  'session-start': 'session-start.js',
  'pre-compact': 'session-start.js',
};

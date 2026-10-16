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

// The wiring between hooks/hooks.json and the handler modules.
//
// Kept in its own file because two places need it and neither should own it:
// lib/cli.js dispatches on it, and the doctor checks hooks.json against it.
// A second copy would let the manifest and the dispatcher disagree, and the
// symptom of that disagreement is a hook that silently never runs.

/**
 * Hook event name, as passed to `pdkit hook <event>`, mapped to its module.
 *
 * `subagent-stop` is registered on the host's `SubagentStop` and runs the
 * receipt gate in task-completed.js — the module keeps its old name, the event
 * does not. Until 0.4.0 it was registered on `TaskCompleted`, which in Claude
 * Code fires when a TaskUpdate marks a task-list item complete or an agent-team
 * teammate finishes, never when an Agent-tool subagent returns. The plugin uses
 * neither, so for four months the receipt gate and the `agent-done` count were
 * wired to an event that never came, and the journal looked exactly like a gate
 * with nothing to refuse. `TaskCompleted` is not registered at all now: there is
 * nothing in this plugin for it to guard, and a handler on it would count task
 * list ticks as subagents.
 */
export const HOOK_HANDLERS = {
  'pre-bash': 'dispatch.js',
  'pre-write': 'owns.js',
  'post-write': 'post-write.js',
  'subagent-stop': 'task-completed.js',
  'session-start': 'session-start.js',
  'pre-compact': 'session-start.js',
};

/**
 * Events where a handler that cannot run means "no", not "go ahead".
 *
 * Every other event fails open, so a half-built plugin does not brick the
 * session — a handler that has decided nothing should not stop work. `pre-bash`
 * is the exception because it guards writes to someone else's repository: a
 * handler that fails to load there is not an incomplete feature, it is the
 * gate being off, and the failure mode is silent.
 *
 * The trade is deliberate. A broken dispatch.js now blocks every Bash call
 * with a message naming the problem, which is loud, immediate and fixable. The
 * alternative is an agent pushing to upstream while the plugin reports nothing
 * at all.
 */
export const FAIL_CLOSED = ['pre-bash'];

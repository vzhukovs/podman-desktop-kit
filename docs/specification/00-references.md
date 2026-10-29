# 0. What is taken from the references, and what is rejected

[Specification](README.md) › Section 0

Four projects solve neighbouring problems, and the plugin is largely an
assembly of their answers with one structural change.

| Source | Taken | Why it works | Not taken |
|---|---|---|---|
| **github/spec-kit** | The **constitution**: a set of project rules every phase refers to. `[NEEDS DECISION]` markers in a plan instead of silent assumptions. Phase gates with explicit human verification at each seam. | podman-desktop's upstream rules — SPDX, conventional commits, `generate:schemas`, husky and `Signed-off-by` — *are* a constitution. They cannot live in a prompt: both planning and preflight have to reference the same file. | The Python CLI and `specify init` copying templates into your repository. Ours is a fork of somebody else's project; nothing may be littered into it. |
| **automazeio/ccpm** | The **context firewall**: subagents read a lot and return little. Explicit `parallel` / `conflicts_with` / `depends_on` in task metadata. A worktree per unit of work. Local state, synced outward as a separate step. | It addresses exactly what is most expensive here: Opus context, and write collisions between parallel workers. | **GitHub Issues as the database.** ccpm owns its repository and writes epics and sub-issues into it. We work in somebody else's upstream, where service issues and comments are not ours to create. The source of truth is local files. |
| **gmickel/flow-next** | The most important source. **R-IDs**: requirements numbered once, never renumbered, traced spec → task → commit → PR coverage table. **Re-anchoring**: a worker re-reads the plan, the task and git state before starting. **Receipts**: "done" means attached command output, not narrative. **Adversarial gates**: plan and implementation reviewed by a separate instance with fresh context. **PR-as-cognitive-aid**: the body is a tool for the reviewer. **Source tagging** (`[user]` / `[paraphrase]` / `[inferred]`) on requirements. **Auto-blocking** a task after N attempts. **A thin deterministic CLI with the agent as the intelligence.** | It is a set of answers to failures that had already been observed: planning without reading code, "done" without proof, a model agreeing with its own plan, drift over a long session. | **Autonomous overnight runs.** For a fork that opens upstream pull requests this is unnecessary and dangerous: the cost of a mistake is public noise in a project you do not own. **Cross-model review** through an external CLI — a separate dependency; replaced with fresh-context review, with the caveat in [section 11](11-known-weaknesses.md). |
| **wshobson/agents** | Per-agent model selection in frontmatter as routing rather than manual terminal juggling. Narrow reviewer specialisation by axis, run in parallel and synthesised afterwards. | Reviewing somebody else's pull request is exactly a parallel multi-axis read. | Auto-delegation by `description`. For a workflow plugin that is a source of surprise activations; every orchestrating skill here is `disable-model-invocation: true`. |

**The one structural divergence from all four.** Each assumes you own the
repository and can keep state inside it — `.flow/`, `.claude/epics/`,
`.specify/`. We work in a fork that upstream pull requests leave from, so
service state in the working tree is a risk of it reaching a diff and then a
pull request. **State therefore lives outside the repository**, in
`$PDKIT_HOME`, keyed by issue number. That also settles worktrees: five
worktrees see one state rather than five copies of it.

---

**In brief** — [`architecture/`](../architecture/README.md): [1 · The constraint](../architecture/01-constraint.md)

← [Contents](README.md) · [1 · Domain model](01-domain-model.md) →

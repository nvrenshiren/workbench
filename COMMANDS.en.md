# opcflow CLI Command Reference

← Back to [README](README.en.md) · [简体中文](COMMANDS.md) · **English**

Every command: `opcflow <command> [args]` (after a global install; or `npx -y @dawipong/opcflow <command>` without installing). For configuration see [CONFIG.en.md](CONFIG.en.md).

**Conventions**

- Global `--project=<path>` sets the project root; otherwise it searches upward from the cwd for `workbench.config.json`.
- File-path arguments go after `--` (e.g. `submit --actor=pm -- docs/prd/modules/user.md`) so they aren't parsed as options.
- `<id>` is a positional argument (e.g. `show 12`).
- **Approval actions (approve/reject) are deliberately human-only**; the AI uses the MCP `wb_*` typed tools (same source & transaction as the CLI) and never sees an approval entry point. Even if an agent bypasses to the CLI via shell, the engine rejects any pipeline role as the `--actor` for approval (approve/reject and "prototype 👍 release" alike) — the actor must be a human identity.

---

## Tasks

- **`list`** `[--status --assignee --module --role --endpoint --type --stale=true]` —— list tasks by filter. *When:* start your day with `list --assignee=<your-role> --status=pending`; `--stale=true` shows only tasks whose upstream changed and need re-checking.
- **`show <id>`** `[--json=true]` —— single-task detail: event timeline, outputs, the stale upstream list. *When:* confirm context before claiming, or investigate why it went stale.
- **`create`** `--role --creator [--module --endpoint --page --type --content --assignee]` —— create a task manually. *When:* ad-hoc tasks outside the pipeline; normal business tasks are auto-dispatched by `plan`.
- **`claim <id>`** `--assignee=<role>` —— claim a task: passes the gate (checks upstream contracts exist/approved) and snapshots the current dependency hashes as the stale baseline. *When:* every agent's first step; claiming locks it — a second claimant collides and fails.
- **`update <id>`** `--status --operator [--force=true]` —— change status (pending/in_progress/completed/cancelled); on `complete` it runs the machineChecks + protocolLints gates. `--force=true` bypasses the stale block (traced). *When:* finish with `update <id> --status=completed`; use `--force` when upstream just changed but you've verified no impact.
- **`remove <id>`** `--operator [--force=true]` —— delete a task. *When:* clean up mistaken/abandoned tasks.
- **`record <id> "note"`** `--operator` —— add a note event. *When:* leave a decision/gotcha record on the event stream for later.
- **`input <id> -- <path>`** `--operator` —— declare a dependency you actually read outside the gate, bringing it under stale monitoring. *When:* you referenced a file outside the standard dependency set (e.g. another endpoint's design system) — after declaring, its change marks you stale too.

## Outputs

- **`output -- <path>`** `--role --endpoint [--module --page --task]` —— register an output file, auto-linking your currently claimed task. *When:* after writing a non-code artifact (PRD/contract/prototype), register it into the DAG.
- **`artifacts`** `[--module --endpoint --page --kind]` —— list artifacts with approval status. *When:* see a module's contracts and whether each is draft/pending/approved.
- **`scan`** `[--actor]` —— full scan of docs + codeRoots to register every artifact and derive DAG edges by kind tier (**reconciling**: stale derived edges are pruned to match coordinate facts, manually declared edges are never touched); code is registered at directory level (not per file). After changing config like `moduleMapping` / `kinds` overrides, **already-registered rows' coordinates converge too (remapped via `coords_remapped`; the content hash is untouched so approval survives)**; file **renames/moves are followed automatically** (a unique missing candidate with the same content hash → path updated keeping the id, approval and relations survive, traced via `auto_moved`). *When:* bulk-land files then register in one shot; you never hand-`output` code — scan maintains it; re-run after tweaking merge/kind rules to converge old rows; git post-commit runs it too.
- **`move --from=<> --to=<>`** `--actor` —— move an artifact's path, keeping its id and approval (unchanged content stays approved). *When:* restructuring directories without breaking approval or falsely staling downstream.

## Trust (approval loop)

- **`submit -- <path>`** `--actor` —— submit for review: mark current content pending. *When:* an agent submits a produced contract for human review.
- **`approve -- <path>`** `--actor [--trivial=true]` —— approve: mint the current content hash as the approved anchor. `--actor` must be a human identity — pipeline roles are rejected by the engine (human review is not outsourced). `--trivial=true` for tweaks: re-bless downstream snapshots + close derived reviews (don't disturb downstream). *When:* **your action**; nod after reviewing the diff in the queue. Use `--trivial` for typo-level edits to avoid downstream rework.
- **`reject -- <path>`** `--actor --reason` —— reject: clear the submitted state, fall back to draft, keep the reason (`--actor` must be human, same as approve). *When:* **your action**; the contract has a problem — say why in a line.
- **`feedback -- <path>`** `--actor --verdict=+1|-1 [--comment --task]` —— 👍/👎 an artifact; for prototypes 👍 = feedback + approval in one (release, so the actor must be human — roles are rejected), 👎 requires a comment. *When:* prototype review; day-to-day scoring of code/artifacts feeds the evolution mechanism (retro).
- **`dispute -- <path>`** `--actor --reason` —— trace an objection to already-approved content and stop for your ruling. *When:* an agent consuming an upstream contract finds the contract itself is wrong — instead of deviating, it leaves evidence and halts.
- **`queue`** —— review queue (pending + invalidated). *When:* your daily entry point: what's waiting for review, what needs re-review due to upstream change.
- **`sync`** `[--actor]` —— reconcile: re-scan content → invalidation propagation → dispatch review down the DAG (deduped) → handle deletions (tombstones). *When:* align state after hand-editing files in bulk; runs on post-commit.

## Flow

- **`plan`** `--module [--creator]` —— once contracts are approved, dispatch the module's downstream tasks (architect/designer/developer/qa) in one shot, idempotent; deleting a page PRD auto-cancels its tasks. *When:* module PRD approved — lay out the build tasks with one command.
- **`qa <id>`** `--result=pass|fail --operator [--reason]` —— record an acceptance result; fail (reason required) auto-dispatches rework, rework completion auto-dispatches re-verification, until pass. *When:* QA fills in results after acceptance; fail→rework→re-verify is fully automatic.
- **`audit`** `--module` —— module contract reconciliation report: settlement status, each contract's approval state, suggested submit list. *When:* before work, confirm a module's contracts are complete/settled.
- **`graph`** `--module` —— emit the module's Mermaid relationship chain (nodes tiered by kind, colored by approval status). *When:* visualize a module's doc→task→code dependencies and states.
- **`lint`** `[--role --endpoint]` —— run protocolLints standalone (not the complete gate). *When:* self-check before submitting whether you tripped a project convention.
- **`events`** `[<id> | --taskId --module --event --limit --json]` —— event stream. *When:* audit who did what when; investigate how the state got where it is.
- **`intake`** —— pull open GitHub issues into the queue: label containing `bug` → hotfix (developer fast lane), otherwise → PM analysis task (standard lane), deduped by `gh#<n>`. *When:* wire issues into the pipeline; requires the `gh` CLI.

## Evolution / Maintenance

- **`retro`** `[--module --json]` —— retrospective: half-life-weighted candidates / Red Flags / approval throughput (thresholds `candidateThreshold` / `redFlagThreshold` configurable, default 3 / 2). *When:* periodic review — hand the candidate evidence to the AI to decide whether it becomes a **skill / rule / memory**; negatives split the same way (machine-checkable → rule, general pitfall → the skill's Red Flags, role-specific → memory).
- **`export`** —— export all events / feedback as jsonl (into `.workbench/`). *When:* offline analysis, backup; runs on post-commit.
- **`init`** `--endpoints [--platforms --model --language --hooks=false --preset=false --writehooks=false]` —— bootstrap an empty project (run bare in a terminal for interactive prompts). *When:* land agent/MCP/hooks/config/docs scaffolding for a new project in one go.
- **`gen-agents`** —— regenerate each platform's agent definitions from templates. *When:* after changing config (endpoints/platforms/codeRoots) or upgrading templates.
- **`register-meta`** `[--actor]` —— register meta artifacts as draft: agent-def/skill/plan/hook-script, plus **platform rules & memory** (claude's `.claude/agent-memory/`, cursor's `.cursor/rules/` — approval:none, registered & change-tracked only, no review gate since platforms consume them directly; hand-edited CLAUDE.md/AGENTS.md and Cursor's native non-file Memories are deliberately untracked). *When:* after an AI drafts a skill, register then submit→human review; register rules/memory when you want their changes in the event stream and relation graph.
- **`install-hooks`** —— install git hooks (post-commit reconciliation). *When:* init ran in a non-git repo and you `git init`ed later.
- **`migrate`** `--from=<path>` —— migrate a legacy `tasks/task.db` into the new DB (old tasks marked legacy, idempotent). *When:* upgrading from a pre-workbench database.

## Service & Integration (mostly auto-invoked by platform / git)

- **`serve`** `[--project --port=5620 --host=0.0.0.0]` —— start the visual workbench (HTTP + SSE). *When:* your main approval UI; open to the LAN by default, the basis for team self-hosting. **No write auth by default** — for multi-user / untrusted networks, set `config.server.authToken` to require a token on write endpoints (see [CONFIG.en.md](CONFIG.en.md)).
- **`mcp`** `[--project]` —— start the MCP server (stdio), exposing the `wb_*` typed tools to AI platforms. *When:* auto-launched by each platform's MCP config; rarely run by hand.
- **`hook pre|post --platform=<id>`** —— agent pre/post tool-call hook (write gate / refresh). *When:* auto-invoked by the platform hooks config.
- **`postcommit`** —— after a git commit: scan + sync + orphan detection + export. *When:* auto-invoked by the git post-commit hook.

---
name: crew
description: |
  Run a visible role crew from a main brain session, with each role in its own Herdr pane.
  Use when the user wants scout/oracle/executor/reviewer-style delegation for pragmatic
  day-to-day coding workflows. Prefer the crew_launch extension tool.
---

# Crew

Use this skill when the user wants the current Pi session to delegate work to visible Herdr role panes.

Use only the project-local crew tools for normal delegation.

## Core model

- The current Pi session is the **brain** and remains the final decision-maker.
- Each delegated role runs as a separate agent in its own visible Herdr pane.
- Keep role panes visible after completion unless the user requests cleanup or explicitly enables safe ephemeral teardown.
- Reuse an idle same-cwd role pane in the same workspace/tab by default.
- Prefer short, focused role tasks over long autonomous chains.
- Use one mutation-capable role in the active project at a time unless the user explicitly requests isolated worktrees or parallel writers.

## Roles

Built-in roles:

- `scout`: read-only context and research
- `oracle`: read-only planning and tradeoff advice
- `executor`: mutation-capable implementation
- `reviewer`: strictly read-only validation

There is one executor role. Do not invent or launch `executor-escalation`. Retry the configured executor at most twice for a failed implementation or review-fix loop, then stop and ask the user.

Custom roles may be added in crew config. Unknown roles should not be invented; ask the user to define them.

## Config

`crew_launch` and `crew_rules` read `model-tiers.json` for model mappings, role descriptions, authorities, and reasoning levels.

Lookup order:

1. The nearest `./.pi/model-tiers.json`, searching from the delegated pane working directory upward
2. `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/skills/crew/model-tiers.json`
3. `~/.pi/model-tiers.json`

Config shape:

```json
{
  "models": {
    "frontier": "anthropic/claude-opus-5",
    "medium": "anthropic/claude-opus-4-8",
    "small": "google/gemini-3.8-flash"
  },
  "crewRoles": {
    "executor": {
      "model": "small",
      "reasoning": "medium",
      "authority": "can-edit",
      "description": "Implements one approved phase..."
    }
  },
  "parallelCodeReview": {
    "testRunner": { "model": "small", "reasoning": "low" }
  }
}
```

Each role names an abstract model tier (`frontier`, `medium`, or `small`) or an inline provider/model escape hatch, plus a concrete Pi thinking level and authority.

| Role | Model tier | Reasoning |
|---|---|---|
| `scout` | `medium` | `medium` |
| `oracle` | `frontier` | `xhigh` |
| `executor` | `small` | `medium` |
| `reviewer` | `frontier` | `xhigh` |

Use `crew_rules` to inspect resolved configuration when needed.

## Normalize every implementation request into phases

Before code execution, the brain converts the request into one explicit phase plan.

### Raw prompt

Derive the goal, constraints, affected areas, acceptance criteria, validation, dependencies, and ordered phases. Use scout or oracle only when they materially reduce uncertainty.

### User-supplied plan

Preserve the user's intent and accepted decisions. Add only missing phase IDs, dependencies, source boundaries, acceptance criteria, validation, architecture references, and review metadata. Do not silently redesign the plan. Ask for approval only when normalization changes meaning or unresolved ambiguity would affect implementation.

### Phase contract

Every phase contains:

- stable ID and title
- one objective
- dependencies
- expected paths
- acceptance criteria
- validation commands/checks
- applicable `AGENTS.md`, ADRs, and accepted architecture decisions
- `riskClass`: `standard` or `major`, with a reason
- `reviewTiming`: `final` or `immediate`
- status: `pending`, `current`, `implemented`, `completed`, or `blocked`

Read applicable `AGENTS.md` and architecture documents before classifying or executing phases. Capture the Git baseline before phase 1 and preserve unrelated pre-existing changes.

## Risk classification

A phase is **major** and uses `reviewTiming: immediate` when any condition applies:

- architecture or module boundaries change across multiple subsystems
- a persisted schema, protocol, public API, authorization/capability model, deployment path, or rollback behavior changes
- a migration, runtime dependency, or broad build/container/runner change is introduced
- the expected or actual diff reaches 8 code files or 300 changed code lines, excluding generated files and lockfile churn
- the brain cannot confidently isolate or validate the change

All other phases are **standard** and use `reviewTiming: final`. Documentation-only, test-only, and localized implementation changes normally remain standard.

Classify during planning and again from the executor's actual report/diff. Actual impact may promote standard to major. Never silently demote a planned major phase.

## Delegation contracts

The role cannot see the parent conversation. Never send unresolved references such as “above,” “that,” “the plan,” or “implement it.” Include only current authoritative context.

Role emphasis:

- `scout`: targeted symbols/paths, boundaries, reusable evidence, unknowns
- `oracle`: current decision, constraints, tradeoffs, acceptable risk
- `executor`: one approved phase, expected files, validation, exact source scope, risk/review metadata, and report format; require changed files, actual diff size, assumptions, unverified behavior, and risks
- `reviewer`: exact phase or review-batch contract and exact source snapshot, not executor reasoning; require a structured verdict and distinct blocking findings

Use `allowContextLookup: true` only when a role may need one concrete missing fact from the frozen parent branch. It does not replay history automatically.

## Execution and review policy

### Standard phase

1. Launch the executor with `riskClass: standard` and `reviewTiming: final`.
2. Require successful phase validation and a current executor report.
3. Reclassify from the actual diff. If promoted to major, use `crew_control action=task-promote` and follow the major gate instead.
4. Use `crew_control action=task-defer` for managed work.
5. Mark the plan phase `implemented`, not `completed`, and create only a provisional checkpoint.
6. Continue to the next phase without launching a reviewer.

Standard work remains provisional until the final deferred review batch passes.

### Major phase

1. Launch the executor with `riskClass: major` and `reviewTiming: immediate`.
2. Launch the reviewer on the exact submitted task snapshot before advancing.
3. `PASS` completes the phase.
4. `REVISION_NEEDED` re-launches the same executor with the blocking findings, then reviews again.
5. Cap the fix loop at two rounds. Escalate unresolved findings to the user.

Validation failures block progress regardless of review timing.

### Final deferred review batch

At plan end, collect every still-deferred standard attempt into one exact review unit:

1. Capture the union of changed source paths and its final source snapshot.
2. Publish one brain-authored `report` manifest identifying the batch task, contract, base/head, snapshot, ordered members, member contracts, and report artifact IDs.
3. Call `crew_control action=review-batch-create` with the same identity, source scope, manifest artifact, and unique deferred member attempts.
4. Launch `reviewer` in managed mode using the batch task ID.
5. `PASS` approves all listed members and lets their plan phases become `completed`.
6. `REVISION_NEEDED` or `BLOCKED` keeps the plan incomplete. Create focused fix phases and repeat within the two-round limit.

A batch verdict covers only its listed members and exact snapshot. Never use the last ordinary phase as a proxy for cumulative review.

## Herdr child-session status

Every delegation has a stable `launchId`. Treat these as separate authorities:

- controller state: queued/starting/prompting/running/blocked/settled/timed-out/lost/replaced/failed
- raw Herdr state: idle/working/blocked/done/unknown
- managed task state: ready/running/submitted/deferred/reviewing/approved/etc.
- completion evidence: terminal marker pair for ordinary work; current artifact/verdict for managed work

Use `crew_status` when a launch times out, blocks, is resumed, or its identity is uncertain. `/crew-status` gives the user the same compact view.

Rules:

- Idle/done without required completion evidence is settled but incomplete, not success.
- Timed out while Herdr still reports a live child is resumable; wait or inspect instead of recovering.
- A pane or `agent_session` mismatch means the old launch was replaced. Do not attribute new output to it.
- A disappeared agent is lost. Use managed recovery only after corroborating inactivity; writer attempts fail safely, while orphaned reviewer attempts return to the submitted review gate for a fresh reviewer launch.
- Never answer a blocked approval/question or kill a child automatically. Inspect and ask the user.
- Child status is restored from parent-session lifecycle entries after resume/reload and corroborated with Herdr before action.

## Final integration gate

After all feature review gates pass, always run the installed `parallel-code-review` skill over the complete plan diff from the captured baseline through the final worktree. Include relevant staged, unstaged, and untracked files, and give every review agent the same concrete scope.

If `parallel-code-review` is unavailable, stop and tell the user; do not silently skip it.

Triage the synthesis as follows:

- Critical, High, and Medium findings are mandatory fixes when compatible with project rules and accepted architecture.
- Failing tests, lint, or type checks are blocking regardless of assigned severity.
- Low findings are optional and are not applied automatically.
- Precedence: user instructions and applicable `AGENTS.md` > accepted ADR/plan/checkpoint decisions > correctness/security findings > style preferences.
- A conflicting finding requires a record containing its ID, source, severity, exact conflicting rule/decision, rationale, and residual risk.
- Ask the user before waiving a Critical/High security or correctness finding.

After fixes, rerun tests/static checks and affected review agents. Repeat the full parallel review when fixes materially change integration behavior. Finish only when no compatible Medium-or-higher finding remains unresolved.

## Using `crew_launch`

Supply:

- `role` and a self-contained `task`
- relevant `context`, `constraints`, `acceptanceCriteria`, and `expectedOutput`
- `riskClass` and `reviewTiming` for code phases
- optional stable `launchId`; otherwise the tool call ID is used
- for managed implementation/review: `durable`, run/task/attempt identity, contract/base, and exact `sourcePaths`
- timeout controls only when defaults are insufficient

`managedAction: status|wait|recover` remains available for durable task state. Use `crew_status` for normalized Herdr child/session state across ordinary and managed launches.

## Reading role output

Preserve detailed reviewer/oracle/scout findings unless the user asks for a summary. Keep numbered findings, caveats, verdicts, sources, and file references. Incomplete diagnostic output is not a final answer.

## Checkpoints and handoffs

- Standard implemented phases receive provisional checkpoints.
- A fresh-session `/crew-handoff` is allowed only after a passed major phase boundary or a passed final review batch.
- Keep immutable contracts and evidence referenced rather than replaying transcripts.
- Treat 75K current-context tokens as a warning and 125K as a checkpoint recommendation.
- Preview cleanup and delete only owner-scoped obsolete evidence after a replacing approved checkpoint exists.
- Never delete live blockers, source, Git objects, user panes, or sole report/review evidence.

## Minimal operating principle

1. Normalize the request into phases.
2. Delegate one focused phase.
3. Track the exact Herdr child/session and read the detailed result.
4. Review major phases immediately; defer standard phases.
5. Run one final batch reviewer for deferred work.
6. Run `parallel-code-review`, resolve compatible Medium+ findings, and re-verify.

---
name: crew
description: |
  Run a visible role crew from a main brain session, with each role in its own Herdr pane.
  Use when the user wants scout/oracle/executor/reviewer-style delegation for pragmatic
  day-to-day coding workflows. Prefer the crew_launch extension tool.
---

# Crew

Use this skill when the user wants the current Pi session to delegate work to visible role panes managed by Herdr.

Use only the project-local `crew_launch` tool for normal delegation.

## Core model

- The current Pi session is the **brain**.
- The brain remains the final decision-maker.
- Each delegated role runs as a separate agent in its own visible Herdr pane.
- Keep role panes visible after completion unless the user asks to clean them up.
- Reuse an idle same-cwd role pane in the same workspace/tab by default, so roles stay close to the brain pane.
- Prefer short, focused role tasks over long autonomous chains.

## Roles

Built-in roles:

- `scout`: read-only context and research
- `oracle`: read-only planning and tradeoff advice
- `executor`: mutation-capable implementation
- `reviewer`: strictly read-only validation

Custom roles may be added in crew config. Unknown roles should not be invented; ask the user to define them.

## Config

`crew_launch` and `crew_rules` read crew config for role descriptions, authorities, and launch models.

Lookup order:

1. The nearest `./.pi/crew.config.json`, searching from the delegated pane working directory upward
2. `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/skills/crew/crew.config.json`
3. `~/.pi/crew.config.json`

Config shape:

```json
{
  "roles": {
    "scout": {
      "description": "Finds local and online context...",
      "model": "google/gemini-3.8-flash",
      "effort": "medium",
      "authority": "read-only"
    }
  }
}
```

Use `description` as the role's standing behavior, `model` as an exact provider/id, `effort` as a supported Pi thinking level, and `authority` as either `read-only` or `can-edit`.

Use `crew_rules` to inspect the resolved role configuration and source path when needed.

## Model & effort assignments

Resolved model and effort per role for this environment. Effort is the reasoning/thinking level.

| Layer / role | Model | Effort |
|---|---|---|
| brain (session) | `anthropic/claude-opus-4-8` | `medium`; `xhigh` for difficult decisions |
| `scout` | `google/gemini-3.8-flash` | `medium` |
| `oracle` | `anthropic/claude-opus-5` | `xhigh` |
| `executor` (default) | `google/gemini-3.8-flash` | `medium` |
| `executor` (explicit difficult-task escalation) | `anthropic/claude-opus-4-8` | `medium` |
| `reviewer` | `anthropic/claude-opus-5` | `xhigh` |

Notes:

- The `model` field in crew config must be a plain `provider/id`. Keep `effort` separate; the extension validates it and forwards it with Pi's `--thinking` option.
- The brain's model/effort is fixed at session launch (`pi --model anthropic/claude-opus-4-8 --thinking medium`, or `xhigh` for difficult decisions), not by crew config. Do not hot-swap an active parent merely to match this table.
- GPT Sol medium may be selected temporarily for implementation when explicitly requested; it is not the permanent crew profile.
- Parallel-code-review resolves `frontier` and final synthesis to Opus 4.8 medium, `mid` to Gemini Flash medium, and `small` to Gemini Flash low through environment mapping rather than hardcoded portable-skill model names.

## Using `crew_launch`

For ordinary delegation, call `crew_launch` with:

- `role`: role name, such as `scout`, `oracle`, `executor`, `reviewer`, or a configured custom role
- `task`: a fully expanded, self-contained objective; the role cannot see the parent conversation
- optional `context`, `constraints`, `acceptanceCriteria`, and `expectedOutput`
- optional `startupTimeoutMs`, `timeoutMs` (inactivity wait bounded by a hard ceiling), `hardCapMs`, and `readLines` only when defaults are insufficient
- for managed implementation/review, a compact current contract, explicit `sourcePaths`, contract/base identity, and immutable evidence references; use `managedAction: "wait"` to resume a timed-out wait without spending a model call
- `allowContextLookup: true` only when a role may need a concrete missing fact from the frozen invoking-parent branch; it never replays history automatically and is limited to four calls/24,000 characters

Never send unresolved references such as "above", "that", "the plan", or "implement it". Expand paths, decisions, constraints, and desired output in the contract.

`crew_launch` handles pane creation/reuse, model launch, scoped agent names, prompting, waiting, queuing, and reading output.

Because Herdr agent names are globally unique, `crew_launch` may use a scoped name such as `scout-w5-t6` when plain `scout` is already used elsewhere. The prompt still says "You are scout...", so role behavior is unchanged.

For successful calls, `crew_launch` returns the role's marked final answer and hides terminal scrollback. Preserve that output unless the user asks for a summary.

## Prompting conventions

The user can be terse, such as "ask scout to map the auth flow". The brain expands that into a compact role contract using the role config.

Before delegating any role, include enough context for that role to succeed. Prefer the compact plan index plus the current phase contract and immutable references. Include changed mandatory requirements inline; do not include prior transcripts or duplicate full evidence and paraphrases. Do not send unresolved references like "above", "that", "the plan", "the review", or "implement it".

Include only what matters:

- role identity
- configured role description and authority
- task objective
- relevant context from the brain
- expected output shape when useful
- true invariants and constraints

Role-specific emphasis:

- `scout`: targeted symbols/paths, boundaries, reusable evidence references, and what remains unknown
- `oracle`: the current decision, constraints, tradeoffs, and acceptable risk—not a replay of completed planning
- `executor`: one approved phase, expected files, validation, exact snapshot scope, and report format. Require self-assessment: unverified behavior, assumptions, and risky areas.
- `reviewer`: current contract and exact committed or uncommitted snapshot, not executor reasoning. Require `VERDICT: PASS` or `VERDICT: CHANGES_REQUIRED`, blocking findings, and verification performed.
- custom roles: purpose, allowed authority, and expected output

Avoid long procedural scripts. Define the destination and constraints, then let the role choose the efficient path.

Examples:

- user says: "ask scout where this is handled"
- brain uses `crew_launch`: role `scout`, task "Find where this behavior is handled. Return relevant files/symbols, key observations, risks, and suggested next steps."

- user says: "ask oracle for a plan"
- brain uses `crew_launch`: role `oracle`, task "Given the context below, propose a pragmatic implementation plan with tradeoffs, risks, and a recommended sequence."

- user says: "ask executor to implement it"
- brain uses `crew_launch`: role `executor`, task "Implement the approved scope below. Context: <relevant plan/decision/requirements>. Return changed files, validation, and remaining risks."

- user says: "ask reviewer to check the diff"
- brain uses `crew_launch`: role `reviewer`, task "Review the current diff against the goal below. Return a verdict, blocking findings, test gaps, and residual risks."

## Reading role output

When the user asks to read a role status or output, preserve detail by default.

Return:

1. role name, status/pane details when useful
2. the role output verbatim or near-verbatim

Do not compress reviewer/oracle/scout findings into a short summary unless the user asks for a summary. Preserve numbered findings, bullets, caveats, verdicts, sources, and file references. If output is too long, include the most relevant contiguous section and say what was truncated.

## Sequencing patterns

Use only the roles that materially improve the outcome, but the execution gate below is mandatory for any code change.

- Scout first: `brain -> scout -> brain synthesis -> oracle or executor`
- Plan review: `brain -> scout -> oracle -> brain decision -> executor`
- Implementation (default for code changes): `brain -> executor -> reviewer -> brain fix loop or acceptance`
- Full flow: `brain -> scout -> oracle -> executor -> reviewer -> brain final`

Never run `brain -> executor` without a following `reviewer` for code-mutating work. In multi-phase plans, apply the execution gate per phase: review after each phase's executor before starting the next phase, not once at the very end.

## Execution gate

Any `executor` run that mutates code is **provisional** until a `reviewer` passes it. Before the brain marks a task or phase complete, or starts the next phase, it **must** launch `reviewer` on the executor's diff. The brain may not accept executor self-reports as final.

Review and fix loop:

1. `executor` implements and returns changed files, validation, and a self-assessment (what could not be verified, assumptions, risky areas).
2. `reviewer` inspects the diff and returns a verdict: `VERDICT: PASS` or `VERDICT: CHANGES_REQUIRED` with blocking findings.
3. If `CHANGES_REQUIRED`: the brain re-launches `executor` with the reviewer's blocking findings as explicit context, then repeats from step 2.
4. Cap the loop at 2-3 iterations. If the work is still failing review after the cap, stop looping and escalate to the user with the outstanding findings.
5. Only a `VERDICT: PASS` (or an explicit user override) lets the brain accept the work and advance.

## Pane lifecycle

Default behavior is owned by `crew_launch`:

- reuse an idle matching role pane near the brain when possible
- otherwise create a visible pane near the brain
- keep user focus on the brain pane
- leave completed role panes visible for inspection
- close only panes created by the current workflow and only when the user asks for cleanup
- never kill a blocked agent without reading the pane and asking the user when approval, credentials, destructive actions, or ambiguity are involved

## Authority model

The brain owns delegation, synthesis, and final acceptance. Roles do not decide final product, release, merge, or safety questions silently. Escalate unresolved decisions back to the brain.

Use one mutation-capable role in the active project at a time unless the user explicitly requests isolated worktrees or parallel writers. Role authority comes from config; by default scouts, oracles, and reviewers are read-only, and executor is the writer role.

## Checkpoints, context, and cleanup

After an accepted phase, create a compact checkpoint containing constraints, decisions, exact source snapshot, approval, remaining phases, unresolved blockers, and evidence references. Start each managed executor and reviewer in a fresh task session. Use `/crew-handoff` only at an idle, approved boundary when the user wants a fresh brain session; never silently replace the interactive session.

Treat 75K current-context tokens as a warning and 125K as a checkpoint recommendation. These are advisory and use current-request semantics, not cumulative usage. Warnings are queued for the model's next real turn without triggering an autonomous reminder, and managed child warnings are also sent to the brain inbox. Retrieve artifact sections/pages selectively, but fully consume mandatory evidence. Preview cleanup and delete only owner-scoped obsolete evidence after its checkpoint replaces it; terminal status alone does not release sole report/review evidence. Use explicit `task-disposition` only after final acceptance/finalization or abandonment; never delete live blockers, source, Git objects, user panes, or arbitrary session history.

## Minimal operating principle

Keep orchestration boring:

- one role
- one focused task
- read detailed result
- synthesize
- for code-mutating executor work, run the execution gate (reviewer pass) before accepting or advancing
- leave visible for inspection

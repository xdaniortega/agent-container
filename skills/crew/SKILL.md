---
name: crew
description: |
  Run a visible role crew from a main brain session, with each role in its own Herdr pane.
  Use when the user wants scout/oracle/executor/reviewer-style delegation for pragmatic
  day-to-day coding workflows. Prefer the crew_role extension tool.
---

# Crew

Use this skill when the user wants the current Pi session to delegate work to visible role panes managed by Herdr.

Use the project-local `crew_role` tool for normal delegation. If `crew_role` or Herdr is unavailable, stop and tell the user to reload/restart Pi or fix Herdr availability. Do not recreate the old shell workflow by hand.

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

`crew_role` reads crew config for role descriptions, authorities, and launch models.

Lookup order:

1. `~/.pi/crew.config.json`
2. `./.pi/crew.config.json`
3. `./.pi/skills/crew/crew.config.json`
4. `./skills/crew/crew.config.json`
5. built-in defaults

Config shape:

```json
{
  "roles": {
    "scout": {
      "description": "Finds local and online context...",
      "model": "openai-codex/gpt-5.4-mini",
      "authority": "read-only"
    }
  }
}
```

Use `description` as the role's standing behavior, `model` as an exact provider/id, and `authority` as either `read-only` or `can-edit`.

## Using `crew_role`

For ordinary delegation, call `crew_role` with:

- `role`: role name, such as `scout`, `oracle`, `executor`, `reviewer`, or a configured custom role
- `task`: the fully expanded task and relevant context
- optional `timeoutMs` / `readLines` only when defaults are insufficient

`crew_role` handles pane creation/reuse, model launch, scoped agent names, prompting, waiting, and reading output.

Because Herdr agent names are globally unique, `crew_role` may use a scoped name such as `scout-w5-t6` when plain `scout` is already used elsewhere. The prompt still says "You are scout...", so role behavior is unchanged.

For successful calls, `crew_role` returns the role's marked final answer and hides terminal scrollback. Preserve that output unless the user asks for a summary.

## Prompting conventions

The user can be terse, such as "ask scout to map the auth flow". The brain expands that into a compact role contract using the role config.

Before delegating any role, include enough context for that role to succeed. Include relevant prior messages, decisions, files, constraints, role outputs, acceptance criteria, and expected output shape. Do not send unresolved references like "above", "that", "the plan", "the review", or "implement it".

Include only what matters:

- role identity
- configured role description and authority
- task objective
- relevant context from the brain
- expected output shape when useful
- true invariants and constraints

Role-specific emphasis:

- `scout`: where to search, boundaries, and what evidence to return
- `oracle`: decisions needed, constraints, tradeoffs, and acceptable risk
- `executor`: approved scope, files/areas likely involved, validation expectations, and reporting format
- `reviewer`: diff/plan/files to inspect, review criteria, and whether to return blocking findings only or all findings
- custom roles: purpose, allowed authority, and expected output

Avoid long procedural scripts. Define the destination and constraints, then let the role choose the efficient path.

Examples:

- user says: "ask scout where this is handled"
- brain uses `crew_role`: role `scout`, task "Find where this behavior is handled. Return relevant files/symbols, key observations, risks, and suggested next steps."

- user says: "ask oracle for a plan"
- brain uses `crew_role`: role `oracle`, task "Given the context below, propose a pragmatic implementation plan with tradeoffs, risks, and a recommended sequence."

- user says: "ask executor to implement it"
- brain uses `crew_role`: role `executor`, task "Implement the approved scope below. Context: <relevant plan/decision/requirements>. Return changed files, validation, and remaining risks."

- user says: "ask reviewer to check the diff"
- brain uses `crew_role`: role `reviewer`, task "Review the current diff against the goal below. Return a verdict, blocking findings, test gaps, and residual risks."

## Reading role output

When the user asks to read a role status or output, preserve detail by default.

Return:

1. role name, status/pane details when useful
2. the role output verbatim or near-verbatim

Do not compress reviewer/oracle/scout findings into a short summary unless the user asks for a summary. Preserve numbered findings, bullets, caveats, verdicts, sources, and file references. If output is too long, include the most relevant contiguous section and say what was truncated.

## Sequencing patterns

Use only the roles that materially improve the outcome.

- Scout first: `brain -> scout -> brain synthesis -> oracle or executor`
- Plan review: `brain -> scout -> oracle -> brain decision -> executor`
- Implementation review: `brain -> executor -> reviewer -> brain fixes or acceptance`
- Full flow: `brain -> scout -> oracle -> executor -> reviewer -> brain final`

## Pane lifecycle

Default behavior is owned by `crew_role`:

- reuse an idle matching role pane near the brain when possible
- otherwise create a visible pane near the brain
- keep user focus on the brain pane
- leave completed role panes visible for inspection
- close only panes created by the current workflow and only when the user asks for cleanup
- never kill a blocked agent without reading the pane and asking the user when approval, credentials, destructive actions, or ambiguity are involved

## Authority model

The brain owns delegation, synthesis, and final acceptance. Roles do not decide final product, release, merge, or safety questions silently. Escalate unresolved decisions back to the brain.

Use one mutation-capable role in the active project at a time unless the user explicitly requests isolated worktrees or parallel writers. Role authority comes from config; by default scouts, oracles, and reviewers are read-only, and executor is the writer role.

## Minimal operating principle

Keep orchestration boring:

- one role
- one focused task
- read detailed result
- synthesize
- leave visible for inspection

---
name: crew
description: |
  Run a visible role crew from a main brain session, with each role in its own Herdr pane.
  Use when the user wants scout/oracle/executor/reviewer-style delegation for pragmatic
  day-to-day coding workflows. Provides a small command recipe for launching,
  prompting, reading, and leaving visible role panes open.
---

# Crew

Use this skill when the user wants a main brain session to delegate work to a visible crew of role panes managed by Herdr.

This skill is intentionally lightweight. Use the command recipe below for normal runs. Consult the official `herdr` skill only for recovery, unusual layouts, or command syntax changes.

## Core model

- The current Pi session is the **brain**.
- The brain remains the final decision-maker.
- Each delegated role runs as a separate Pi agent in its own Herdr pane.
- Role panes should have clear, unique names such as `scout`, `oracle`, `executor`, and `reviewer`.
- Role panes are temporary but visible by default: create, prompt, wait, read, synthesize, then leave the pane open for user inspection unless the user explicitly asks to clean it up.
- Prefer short, focused role tasks over long autonomous chains.
- This is a day-to-day coding workflow, not a background task-queue system.

## Preconditions

Before controlling Herdr, verify both conditions:

```bash
test "${HERDR_ENV:-}" = 1
command -v herdr >/dev/null 2>&1
```

If `HERDR_ENV` is not `1`, stop and tell the user: "I am not currently running inside Herdr. Start me through Herdr first, then I can orchestrate visible role panes."

If the `herdr` command is missing, stop and tell the user: "I am inside a Herdr pane, but the Herdr CLI is not available in this environment. Install or expose the Herdr CLI in the container, then retry."

Do not inspect or control Herdr from outside a Herdr-managed session. Do not continue without the `herdr` CLI.

## Container rule

When the project is running through the containerized Pi workflow, role panes start a new Pi session through the project runner:

```bash
pic-proxy
```

The brain runs inside the container while Herdr controls host panes. Read the host pane cwd from Herdr, then use that host path for splits:

```bash
herdr pane current --current
```

Use the returned pane `foreground_cwd` when present, otherwise `cwd`. If the returned path is missing or looks wrong, stop and ask the user.

## Roles

### brain

The current Pi session. Owns orchestration and final synthesis.

Responsibilities:

- clarify the user goal
- decide which roles to launch
- write focused prompts for roles
- read role outputs
- resolve conflicts between roles
- decide whether executor may modify files
- ask for review after changes
- report final results to the user

### scout

Read-only context gatherer.

Use for:

- locating relevant files
- understanding project structure
- finding prior art
- identifying constraints
- mapping possible implementation seams

Expected output:

- relevant files and symbols
- key observations
- risks or unknowns
- suggested next investigation

Scout must not modify files.

### oracle

Read-only planner and tradeoff advisor.

Use for:

- architecture choices
- implementation strategy
- sequencing
- risk analysis
- comparing alternatives

Expected output:

- recommended approach
- alternatives considered
- tradeoffs
- risks
- open decisions for the brain

Oracle must not modify files.

### executor

Mutation-capable implementer.

Use only after the brain has a sufficiently clear plan.

Executor may modify files in the current project, following the same authority model as Pi subagents: the brain delegates implementation, but the brain owns final acceptance.

Expected output:

- summary of changes
- files changed
- tests or checks run
- failures or skipped validation
- risks and follow-up items

### reviewer

Read-only validator by default.

Use after planning or implementation.

Expected output:

- actionable findings
- correctness issues
- missed requirements
- test gaps
- maintainability risks
- verdict: approve, approve with nits, request changes, or blocked

Reviewer must not modify files unless explicitly promoted by the brain.

## Standard lifecycle

Default to a sibling pane in the current tab, same host cwd, no focus change.

1. Verify Herdr preconditions with exactly:

   ```bash
   test "${HERDR_ENV:-}" = 1 && command -v herdr >/dev/null 2>&1
   ```

2. Read the current host pane info:

   ```bash
   herdr pane current --current
   ```

3. Choose `role_cwd` from `foreground_cwd`, falling back to `cwd`.
4. Split a pane from the current brain pane using `--cwd "$role_cwd"` and `--no-focus`.
5. In containerized projects, run `pic-proxy` in the new pane.
6. Wait for Herdr to detect the Pi agent in the new pane, then rename it to the role name if needed.
7. Prompt the role with a compact task contract.
8. Wait for the role to settle.
9. Read the role output using `recent-unwrapped`.
10. Synthesize the result into the brain's working context.
11. Leave the completed role pane open for inspection unless the user explicitly requested cleanup. If cleanup is requested, close only panes created by this workflow and only after confirming the agent is idle or done.

Use the command recipe in this skill for normal runs. Consult the official `herdr` skill only for recovery, unusual layouts, or command syntax changes.

## Normal command recipe

Use this recipe for ordinary single-role delegation. Substitute `scout` with the role name and replace the prompt text.

```bash
set -euo pipefail
current_json=$(herdr pane current --current)
role_cwd=$(printf '%s' "$current_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).result.pane; console.log(p.foreground_cwd || p.cwd || "")})')
[ -n "$role_cwd" ]
split_json=$(herdr pane split --current --direction right --cwd "$role_cwd" --no-focus)
role_pane=$(printf '%s' "$split_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).result.pane.pane_id))')
herdr pane run "$role_pane" pic-proxy
herdr agent wait "$role_pane" --timeout 120000
herdr agent rename "$role_pane" scout
herdr agent prompt scout "You are scout. <task>." --wait --timeout 120000
herdr agent read scout --source recent-unwrapped --lines 200
```

For repeated work, reuse an existing named role pane when it is in the same workspace, has the right cwd, and is idle. Otherwise create a new pane.

## Output return policy

Primary path: read the role pane transcript.

Use:

```bash
herdr agent read <role-name> --source recent-unwrapped --lines 200
```

Increase lines when needed, but do not rely on terminal scrollback for very large outputs.

Fallback path: ask the role to write a Markdown handoff file only when pane output is missing, truncated, or too long.

Fallback prompt:

"Your previous answer was not fully recoverable from the terminal. Write your complete final answer as Markdown in a temporary file inside the project or `/tmp`, then reply only with `RESULT_PATH=<path>`."

Do not request file output in the initial prompt unless the task is expected to produce a long report.

## Prompting conventions

The user-facing request can be terse, such as "ask scout to map the auth flow". Do not require the user to repeat role rules like "read-only" or "do not modify files" when the role already defines them.

The brain should expand the user's task into a compact role contract before prompting the pane:

- role identity
- task objective
- relevant context from the brain
- expected output shape
- true invariants only

Avoid long procedural scripts. Define the destination and let the role choose the efficient path.

Examples:

- user says: "ask scout where this is handled"
- brain prompts scout: "You are scout. Goal: find where this behavior is handled. Return relevant files/symbols, key observations, and risks."

- user says: "ask oracle for a plan"
- brain prompts oracle: "You are oracle. Given the context below, propose a pragmatic implementation plan with tradeoffs, risks, and open decisions."

- user says: "ask executor to implement it"
- brain prompts executor: "You are executor. Implement the approved scope below. Keep changes minimal. Return changed files, validation, and remaining risks."

- user says: "ask reviewer to check the diff"
- brain prompts reviewer: "You are reviewer. Review the current diff against the goal below. Return actionable findings and a verdict."

## Sequencing patterns

### Scout first

Use when the brain lacks project context.

```text
brain -> scout -> brain synthesis -> oracle or executor
```

### Plan review

Use before implementation when the change is non-trivial.

```text
brain -> scout -> oracle -> brain decision -> executor
```

### Implementation review

Use after executor changes files.

```text
brain -> executor -> reviewer -> brain fixes or acceptance
```

### Full pragmatic flow

```text
brain -> scout -> oracle -> executor -> reviewer -> brain final
```

Do not force the full flow for small tasks. Use only the roles that materially improve the outcome.

## Pane lifecycle policy

Default:

- role panes are temporary work surfaces, but leave them visible after completion for DX and auditability
- keep user focus on the brain pane with `--no-focus`
- do not close panes unless the user explicitly asks for cleanup, or the prompt explicitly says to clean up after reading
- do not close panes you did not create
- do not kill blocked agents without reading the pane and asking the user if needed

If a role is blocked:

1. read the role pane
2. decide whether the brain can answer safely
3. ask the user when approval, credentials, destructive actions, or ambiguity are involved

## Authority model

The brain owns delegation, synthesis, and final acceptance. Roles do not decide final product, release, merge, or safety questions silently. Escalate unresolved decisions back to the brain.

Use one mutation-capable role in the active project at a time unless the user explicitly requests isolated worktrees or parallel writers. Scouts, oracles, and reviewers are read-only by role. Executor is the normal writer role.

## Model routing

For now, all roles are Pi agents. Do not invent or guess model names.

Model routing should remain configuration-driven and typo-resistant. Until a stable config exists, use the brain's current model for all role panes unless the user gives an exact launch argument.

When the user asks for a specific model or alias:

- use only exact aliases from a maintained crew model map
- if the alias is missing or ambiguous, ask the user instead of guessing
- pass model arguments to `pic-proxy` or the underlying Pi command only when the local runner supports them

Suggested future model map shape, kept as documentation or a small project file, not code:

```text
scout: <exact launch args>
oracle: <exact launch args>
executor: <exact launch args>
reviewer: <exact launch args>
```

Pragmatic defaults once configured:

- brain: strongest reliable general coding/reasoning model
- scout: fast/cheap model is acceptable
- oracle: strongest reasoning model
- executor: strong coding model
- reviewer: strong reasoning/coding review model

## Minimal operating principle

Keep orchestration boring:

- one role
- one focused task
- read result
- synthesize
- leave visible for inspection by default; clean up only when asked

Add scripts only after the manual Herdr command pattern has stabilized.

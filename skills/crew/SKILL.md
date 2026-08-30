---
name: crew
description: |
  Run a visible role crew from a main brain session, with each role in its own Herdr pane.
  Use when the user wants scout/oracle/executor/reviewer-style delegation for pragmatic
  day-to-day coding workflows. Prefer the crew_role extension tool; keep shell usage only
  as a recovery fallback.
---

# Crew

Use this skill when the user wants a main brain session to delegate work to visible role panes managed by Herdr.

Prefer the project-local `crew_role` Pi extension tool. Use shell commands only as a fallback when the tool is unavailable or you are debugging/recovering Herdr state.

## Core model

- The current Pi session is the **brain**.
- The brain remains the final decision-maker.
- Each delegated role runs as a separate agent in its own Herdr pane.
- Leave role panes visible after completion unless the user asks to clean them up.
- Reuse an existing idle same-cwd role pane in the same workspace/tab by default, so role panes stay close to the brain pane.
- Prefer short, focused role tasks over long autonomous chains.

## Roles

Default roles are defined in `crew.config.json` next to this skill and can be copied to `~/.pi/crew.config.json` for global use.

Built-in defaults:

- `scout`: read-only context and research
- `oracle`: read-only planning and tradeoff advice
- `executor`: mutation-capable implementation
- `reviewer`: strictly read-only validation

Custom roles may be added in config. Unknown roles should not be invented; ask the user to define them.

## Config

Global config path:

```text
~/.pi/crew.config.json
```

Default template:

```text
skills/crew/crew.config.json
```

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

Lookup order:

1. `~/.pi/crew.config.json`
2. `./.pi/crew.config.json` when present
3. built-in role defaults from this skill

If a role has no configured model, use the default runner model. Do not invent or fuzzy-match model names. If a requested model or role is missing or ambiguous, ask the user.

## Preflight

Before controlling Herdr, verify:

```bash
test "${HERDR_ENV:-}" = 1 && command -v herdr >/dev/null 2>&1
```

If this fails, stop and tell the user: "I am not currently able to control Herdr from this session. Start me inside Herdr with the Herdr CLI available, then retry."

Role pane launch command depends on where the brain is running: use `pic-proxy` when the brain is inside the containerized Pi runner, otherwise use `pi`.

## Preferred tool

When Pi has discovered the project-local crew extension, use the `crew_role` tool for ordinary single-role delegation instead of hand-running the shell recipe. Pass the role name and focused task. The tool creates or reuses a visible same-workspace/same-cwd/same-tab role pane, applies the configured model when launching a new pane, prompts the role, waits, reads recent output, and returns structured details including pane id, cwd, config path, configuredModel, launchModel, actualModel/actualModelKnown, and whether the pane was reused or created.

Keep panes visible after tool use. If the tool is unavailable, errors before starting the role, or does not cover the needed recovery path, use the fallback shell recipe.

Because Herdr agent names are globally unique, the tool uses a scoped name such as `scout-w5-t6` when plain `scout` is already used in another workspace or tab. The prompt still says "You are scout..." so role behavior is unchanged.

For successful calls, `crew_role` returns the role's marked final answer and hides terminal scrollback. If markers are missing, it falls back to recent-output trimming.

## Shell fallback

Use this only when `crew_role` is unavailable or Herdr needs manual recovery.

```bash
test "${HERDR_ENV:-}" = 1 && command -v herdr >/dev/null 2>&1
herdr pane current --current
herdr agent list
herdr agent prompt <role-or-scoped-agent-name> '<expanded role prompt>' --wait --timeout 120000
herdr agent read <role-or-scoped-agent-name> --source recent-unwrapped --lines 200
```

For pane creation, model selection, scoped names, marker parsing, and normal reuse, delegate to `crew_role` instead of copying the old recipe.

## Reading role output

When the user asks to read a role status or output, preserve detail by default.

Return:

1. role name, Herdr status, pane id, and cwd
2. the recent role output verbatim or near-verbatim

Do not compress reviewer/oracle/scout findings into a short summary unless the user asks for a summary. Preserve numbered findings, bullets, caveats, verdicts, sources, and file references. If the pane output is too long, include the most relevant contiguous section and say what was truncated.

Primary read command:

```bash
herdr agent read <role-name> --source recent-unwrapped --lines 200
```

Fallback: if pane output is missing, truncated, or too long, ask the role:

"Your previous answer was not fully recoverable from the terminal. Write your complete final answer as Markdown in a temporary file inside the project or `/tmp`, then reply only with `RESULT_PATH=<path>`."

## Prompting conventions

The user can be terse, such as "ask scout to map the auth flow". The brain expands that into a compact role contract using the role config.

When the user says "above", "that", "the plan", "the review", "implement it", or similar, the brain must expand the reference before delegating. Include the relevant prior messages, decisions, files, role outputs, and acceptance criteria in the role prompt. Do not send unresolved conversational references to a role pane.

Include only what matters:

- role identity
- configured role description and authority
- task objective
- relevant context from the brain
- expected output shape when needed
- true invariants

Before launching executor, the brain must provide an explicit approved scope. If the implementation depends on earlier scout/oracle/reviewer output, include that output or a faithful excerpt in the executor prompt. If the brain cannot identify the approved scope, ask the user instead of delegating.
Avoid long procedural scripts. Define the destination and let the role choose the efficient path.

Examples:

- user says: "ask scout where this is handled"
- brain prompts scout: "You are scout. Finds local and online context. Authority: read-only. Task: find where this behavior is handled and return relevant files/symbols, key observations, and risks."

- user says: "ask oracle for a plan"
- brain prompts oracle: "You are oracle. Advises on plans, architecture, sequencing, tradeoffs, alternatives, and risks. Authority: read-only. Task: given the context below, propose a pragmatic implementation plan."

- user says: "ask executor to implement it"
- brain prompts executor: "You are executor. Implements the approved plan with minimal pragmatic changes. Authority: can-edit. Task and context: implement the approved scope below. Context: <paste the relevant plan/decision/requirements from the brain conversation>. Return changed files, validation, and remaining risks."

- user says: "ask reviewer to check the diff"
- brain prompts reviewer: "You are reviewer. Reviews plans or diffs for correctness, missed requirements, test gaps, maintainability risks, and actionable findings. Authority: read-only. Task: review the current diff against the goal below and return a verdict."

## Sequencing patterns

Use only the roles that materially improve the outcome.

- Scout first: `brain -> scout -> brain synthesis -> oracle or executor`
- Plan review: `brain -> scout -> oracle -> brain decision -> executor`
- Implementation review: `brain -> executor -> reviewer -> brain fixes or acceptance`
- Full flow: `brain -> scout -> oracle -> executor -> reviewer -> brain final`

## Pane lifecycle

Default:

- reuse an existing named role pane when it is idle, in the same workspace, and in the same cwd
- otherwise create a new pane
- first crew role splits the brain pane to the right
- later crew roles split an existing crew pane downward, keeping the brain pane as the left/main pane
- keep user focus on the brain pane with `--no-focus`
- leave completed role panes visible for inspection
- close only panes created by the current workflow and only when the user asks for cleanup
- never kill a blocked agent without reading the pane and asking the user when approval, credentials, destructive actions, or ambiguity are involved

## Authority model

The brain owns delegation, synthesis, and final acceptance. Roles do not decide final product, release, merge, or safety questions silently. Escalate unresolved decisions back to the brain.

Use one mutation-capable role in the active project at a time unless the user explicitly requests isolated worktrees or parallel writers. Role authority comes from config; by default scouts, oracles, and reviewers are read-only, and executor is the writer role.

## Model routing

Role models come from `~/.pi/crew.config.json` when configured. Use exact provider/id values only. The brain model is whatever Pi was started with; it is not configured here.

## Minimal operating principle

Keep orchestration boring:

- one role
- one focused task
- read detailed result
- synthesize
- leave visible for inspection

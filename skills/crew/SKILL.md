---
name: crew
description: |
  Run a visible role crew from a main brain session, with each role in its own Herdr pane.
  Use when the user wants scout/oracle/executor/reviewer-style delegation for pragmatic
  day-to-day coding workflows. Provides a small command recipe for launching,
  prompting, reading, and leaving visible role panes open.
---

# Crew

Use this skill when the user wants a main brain session to delegate work to visible role panes managed by Herdr.

Use this recipe for normal runs. Consult the official `herdr` skill only for recovery, unusual layouts, or command syntax changes.

## Core model

- The current Pi session is the **brain**.
- The brain remains the final decision-maker.
- Each delegated role runs as a separate agent in its own Herdr pane.
- Role panes have clear names such as `scout`, `oracle`, `executor`, and `reviewer`.
- Leave role panes visible after completion unless the user asks to clean them up.
- Reuse an existing idle same-cwd role pane by default.
- Prefer short, focused role tasks over long autonomous chains.

## Roles

### scout

Read-only context gatherer.

Use for repository reconnaissance, online research, locating files, finding prior art, identifying constraints, and mapping implementation seams.

Expected output: relevant facts, files/symbols or sources, key observations, risks, and suggested next step.

### oracle

Read-only planner and tradeoff advisor.

Use for architecture choices, implementation strategy, sequencing, alternatives, and risk analysis.

Expected output: recommended approach, alternatives, tradeoffs, risks, and open decisions for the brain.

### executor

Mutation-capable implementer.

Use only after the brain has a sufficiently clear plan. Executor may modify files in the current project. The brain owns final acceptance.

Expected output: changed files, summary, validation run, failures or skipped checks, and remaining risks.

### reviewer

Strictly read-only validator.

Use after planning or implementation.

Expected output: actionable findings, file/line evidence when relevant, missed requirements, test gaps, maintainability risks, and verdict: approve, approve with nits, request changes, or blocked.

## Preflight

Before controlling Herdr, verify:

```bash
test "${HERDR_ENV:-}" = 1 && command -v herdr >/dev/null 2>&1
```

If this fails, stop and tell the user: "I am not currently able to control Herdr from this session. Start me inside Herdr with the Herdr CLI available, then retry."

Role pane launch command depends on where the brain is running: use `pic-proxy` when the brain is inside the containerized Pi runner, otherwise use `pi`.

## Normal command recipe

Use this recipe for ordinary single-role delegation. Substitute the role name and prompt text.

```bash
set -euo pipefail

role=scout
prompt='You are scout. <task>.'

if [ "${PIC_HERDR_BRIDGE:-}" = "1" ] || [ -n "${PIC_HERDR_BRIDGE_HOST:-}" ]; then
  role_command=pic-proxy
else
  role_command=pi
fi

current_json=$(herdr pane current --current)
role_cwd=$(printf '%s' "$current_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).result.pane; const cwd=p.foreground_cwd||p.cwd||""; if(!cwd){process.exit(1)} console.log(cwd)})')
workspace_id=$(printf '%s' "$current_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).result.pane; console.log(p.workspace_id||"")})')

role_pane=""
if herdr agent get "$role" >/tmp/crew-agent.json 2>/dev/null; then
  role_pane=$(workspace_id="$workspace_id" role_cwd="$role_cwd" node -e 'const a=require("fs").readFileSync("/tmp/crew-agent.json","utf8"); const p=JSON.parse(a).result.agent; if((p.agent_status==="idle"||p.agent_status==="done") && p.workspace_id===process.env.workspace_id && (p.foreground_cwd===process.env.role_cwd||p.cwd===process.env.role_cwd)){console.log(p.pane_id)}' )
fi

if [ -z "$role_pane" ]; then
  split_json=$(herdr pane split --current --direction right --cwd "$role_cwd" --no-focus)
  role_pane=$(printf '%s' "$split_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).result.pane; if(!p.pane_id){process.exit(1)} console.log(p.pane_id)})')
  created_pane="$role_pane"
  herdr pane run "$role_pane" "$role_command"

  # Agent detection can lag briefly after pane run.
  herdr agent wait "$role_pane" --timeout 120000 || {
    sleep 3
    herdr agent wait "$role_pane" --timeout 120000 || {
      herdr pane read "$role_pane" --source recent-unwrapped --lines 120
      exit 1
    }
  }
  herdr agent rename "$role_pane" "$role"
fi

herdr agent prompt "$role" "$prompt" --wait --timeout 120000 || {
  herdr agent read "$role" --source recent-unwrapped --lines 160
  exit 1
}

herdr agent read "$role" --source recent-unwrapped --lines 200
```

Notes:

- The brain may run inside a container while Herdr controls host panes. Always get the host cwd from `herdr pane current --current`; do not use container `$PWD` for pane creation.
- Use `pic-proxy` for role panes when `PIC_HERDR_BRIDGE=1` or `PIC_HERDR_BRIDGE_HOST` is set. Otherwise use `pi`. If launch fails, read the pane output and report the failure.
- Record `created_pane` when a pane is created. Cleanup may only close panes recorded by the current workflow.
- If a wait or prompt times out, read the role pane output before deciding whether to steer, retry, ask the user, or leave the pane running.

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

The user can be terse, such as "ask scout to map the auth flow". The brain expands that into a compact role contract.

Include only what matters:

- role identity
- task objective
- relevant context from the brain
- expected output shape
- true invariants

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

Use only the roles that materially improve the outcome.

- Scout first: `brain -> scout -> brain synthesis -> oracle or executor`
- Plan review: `brain -> scout -> oracle -> brain decision -> executor`
- Implementation review: `brain -> executor -> reviewer -> brain fixes or acceptance`
- Full flow: `brain -> scout -> oracle -> executor -> reviewer -> brain final`

## Pane lifecycle

Default:

- reuse an existing named role pane when it is idle, in the same workspace, and in the same cwd
- otherwise create a new pane
- keep user focus on the brain pane with `--no-focus`
- leave completed role panes visible for inspection
- close only panes created by the current workflow and only when the user asks for cleanup
- never kill a blocked agent without reading the pane and asking the user when approval, credentials, destructive actions, or ambiguity are involved

## Authority model

The brain owns delegation, synthesis, and final acceptance. Roles do not decide final product, release, merge, or safety questions silently. Escalate unresolved decisions back to the brain.

Use one mutation-capable role in the active project at a time unless the user explicitly requests isolated worktrees or parallel writers. Scouts, oracles, and reviewers are read-only. Executor is the normal writer role.

## Model routing

Use the default runner/model unless the user provides an exact supported launch command or exact configured alias. Do not invent or guess model names. If a requested model or alias is missing or ambiguous, ask the user.

## Minimal operating principle

Keep orchestration boring:

- one role
- one focused task
- read detailed result
- synthesize
- leave visible for inspection

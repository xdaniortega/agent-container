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
- Leave role panes visible after completion unless the user asks to clean them up.
- Reuse an existing idle same-cwd role pane by default.
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

## Normal command recipe

Use this recipe for ordinary single-role delegation. Substitute the role name and user task.

```bash
set -euo pipefail

role=scout
user_task='<task plus the relevant brain context needed to do it>'

config_path=""
if [ -f "$HOME/.pi/crew.config.json" ]; then
  config_path="$HOME/.pi/crew.config.json"
elif [ -f .pi/crew.config.json ]; then
  config_path=.pi/crew.config.json
fi

role_description=""
role_authority=""
role_model=""
if [ -n "$config_path" ]; then
  role_description=$(role="$role" config_path="$config_path" node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.config_path,"utf8")); const r=c.roles?.[process.env.role]; if(r?.description) console.log(r.description)')
  role_authority=$(role="$role" config_path="$config_path" node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.config_path,"utf8")); const r=c.roles?.[process.env.role]; if(r?.authority) console.log(r.authority)')
  role_model=$(role="$role" config_path="$config_path" node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.config_path,"utf8")); const r=c.roles?.[process.env.role]; if(r?.model) console.log(r.model)')
fi

if [ -z "$role_description" ]; then
  case "$role" in
    scout) role_description="Finds local and online context. Reports relevant facts, files, sources, risks, and suggested next steps."; role_authority=${role_authority:-read-only} ;;
    oracle) role_description="Advises on plans, architecture, sequencing, tradeoffs, alternatives, and risks."; role_authority=${role_authority:-read-only} ;;
    executor) role_description="Implements the approved plan with minimal pragmatic changes and reports changed files, validation, and risks."; role_authority=${role_authority:-can-edit} ;;
    reviewer) role_description="Reviews plans or diffs for correctness, missed requirements, test gaps, maintainability risks, and actionable findings."; role_authority=${role_authority:-read-only} ;;
    *) printf 'Unknown crew role: %s\n' "$role" >&2; exit 1 ;;
  esac
fi

prompt="You are $role."
[ -n "$role_description" ] && prompt="$prompt $role_description"
[ -n "$role_authority" ] && prompt="$prompt Authority: $role_authority."
prompt="$prompt Task and context: $user_task"

if [ "${PIC_HERDR_BRIDGE:-}" = "1" ] || [ -n "${PIC_HERDR_BRIDGE_HOST:-}" ]; then
  role_command=pic-proxy
else
  role_command=pi
fi
[ -n "$role_model" ] && role_command="$role_command --model $role_model"

current_json=$(herdr pane current --current)
role_cwd=$(printf '%s' "$current_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).result.pane; const cwd=p.foreground_cwd||p.cwd||""; if(!cwd){process.exit(1)} console.log(cwd)})')
workspace_id=$(printf '%s' "$current_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).result.pane; console.log(p.workspace_id||"")})')

role_pane=""
if herdr agent get "$role" >/tmp/crew-agent.json 2>/dev/null; then
  role_pane=$(workspace_id="$workspace_id" role_cwd="$role_cwd" node -e 'const a=require("fs").readFileSync("/tmp/crew-agent.json","utf8"); const p=JSON.parse(a).result.agent; if((p.agent_status==="idle"||p.agent_status==="done") && p.workspace_id===process.env.workspace_id && (p.foreground_cwd===process.env.role_cwd||p.cwd===process.env.role_cwd)){console.log(p.pane_id)}' )
fi

if [ -z "$role_pane" ]; then
  crew_pane=$(workspace_id="$workspace_id" role_cwd="$role_cwd" node - <<'NODE'
const fs = require('fs');
const known = new Set(['scout', 'oracle', 'executor', 'reviewer']);
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const agents = JSON.parse(input).result.agents || [];
    const match = agents.find(a =>
      known.has(a.name) &&
      a.workspace_id === process.env.workspace_id &&
      (a.foreground_cwd === process.env.role_cwd || a.cwd === process.env.role_cwd)
    );
    if (match) console.log(match.pane_id);
  } catch {}
});
NODE
  <<<"$(herdr agent list)")

  if [ -n "$crew_pane" ]; then
    split_json=$(herdr pane split "$crew_pane" --direction down --cwd "$role_cwd" --no-focus)
  else
    split_json=$(herdr pane split --current --direction right --cwd "$role_cwd" --no-focus)
  fi
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
- A configured model is applied when creating a new role pane. Reused panes keep the model they were launched with; create a fresh pane when changing a role's model.
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

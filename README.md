# agentic-coding-container

Run **Pi** (the Pi coding agent) or **Claude Code** inside an Apple container while editing the current host project directory. The container mounts the current directory as `/workspace/<basename>`, uses your host `~/.pi` and `~/.claude` configurations, and leaves the normal non-containerized commands untouched.

## Commands

| Command | Use when |
|---------|----------|
| `pic` | Containerized Pi with direct networking. |
| `pic --proxy` | Containerized Pi through the host-side proxy. |
| `pic-proxy` | Compatibility alias for `pic --proxy`. |
| `clc-proxy` | Claude Code with host-side proxy, persistent Linux auth, and host-inspectable sessions. |

## Requirements

- macOS 26.x with Apple container installed.
- Apple container system services started.
- Node.js/npm on the host for the command runners.

Install Apple container from:
https://github.com/apple/container/releases

Start the container system:
```bash
container system start
```

## Build the Image

Build the container image:
```bash
container build --dns 1.1.1.1 -t agentic-coding-node:24 .
```

Herdr is pinned in the image (`ARG HERDR_VERSION=0.8.2` with `HERDR_SHA256_AARCH64` and
`HERDR_SHA256_X86_64`). The in-image version must match the host `herdr --version`;
otherwise Herdr calls fail with `protocol_mismatch`. See [Upgrade](#upgrade) to change it.

If Apple `container build` fails with `Temporary failure resolving 'deb.debian.org'`,
the long-running `buildkit` helper may be using the wrong resolver. Repair it with:
```bash
container exec buildkit /bin/sh -lc 'printf "nameserver 1.1.1.1\n" > /etc/resolv.conf'
```
Then rerun the build command.

If a VPN is connected and the build still cannot resolve Debian hosts, the
problem may be broader than DNS: Apple `container`/`buildkit` may be unable to
reach public internet addresses directly. In that case, start a temporary
host-side HTTP/HTTPS proxy on the Apple container bridge and pass it as build
args. First find the bridge gateway address; it is the default network's `ipv4Gateway`
(currently `192.168.65.1` on recent Apple container releases, `192.168.64.1` on older ones):
```bash
container network list --format json
GATEWAY=192.168.65.1   # replace with the ipv4Gateway printed above

npm install

GATEWAY=$GATEWAY node - <<'NODE' &
const ProxyChain = require('proxy-chain');
const server = new ProxyChain.Server({ host: process.env.GATEWAY, port: 8891 });
server.listen().then(() => console.log('proxy listening on ' + process.env.GATEWAY + ':8891'));
process.on('SIGTERM', async () => { await server.close(true); process.exit(0); });
NODE
PID=$!

container build --dns $GATEWAY \
  --build-arg HTTP_PROXY=http://$GATEWAY:8891 \
  --build-arg HTTPS_PROXY=http://$GATEWAY:8891 \
  --build-arg http_proxy=http://$GATEWAY:8891 \
  --build-arg https_proxy=http://$GATEWAY:8891 \
  -t agentic-coding-node:24 .

kill $PID
```

This is helpful when DNS changes such as `--dns 1.1.1.1` or a local router DNS
still fail because the VPN blocks direct public egress from the builder VM.

## Install the Commands

Install dependencies and link the command runners:

```bash
npm install
npm link
```

This installs `pic`, `pic-proxy`, and `clc-proxy`. Remove any existing shell
function or alias named `pic`, because shell definitions take precedence over the
linked executable.

`pic` uses direct networking by default. `pic --proxy` enables the host-side
proxy; the older `pic-proxy` command remains an equivalent compatibility alias.

The proxy and the Herdr bridge bind to the host address of the Apple container
network, auto-detected from `container network list --format json` (the default
network's `ipv4Gateway`, currently `192.168.65.1`). Override with `PIC_PROXY_HOST`,
`PIC_HERDR_BRIDGE_HOST`, or `CLC_PROXY_HOST` (for `clc-proxy`). Neither binds
`0.0.0.0` unless you set `PIC_ALLOW_WILDCARD_BIND=1`.

Direct mode explicitly clears uppercase and lowercase HTTP, HTTPS, and ALL proxy
variables, including when it reuses a container originally started in proxy mode.
Containers started by the runner use `--rm`, and a proxy owned by the runner is
closed when the Pi process exits.

Do not bind-mount macOS `~/.claude.json` into the container. Claude Code stores
macOS credentials in Keychain, while Linux stores credentials under
`$CLAUDE_CONFIG_DIR/.credentials.json`. `clc-proxy` lets you run `/login` once
inside Linux and persists that credential in the host-backed Linux config directory
`~/.clc-container/claude-config`. The directory can be shared by concurrent Apple
Container VMs without attaching one writable block volume to multiple VMs.

Personal agent preferences:
- Pi reads your host `~/.pi/agent/SYSTEM.md` through the normal `~/.pi` mount.
- Claude Code reads user memory from `~/.claude/CLAUDE.md` and
  `~/.claude/rules/*.md`; `clc-proxy` copies those into `/claude-config`.
- For project-local Claude-only notes, use repo-root `CLAUDE.local.md` and keep
  it gitignored. Do not use `.claude.local.md`; Claude Code does not load that
  as a standard memory file.


## Run

From any project directory:
```bash
pic              # Pi with direct networking
pic --proxy      # Pi through the host-side proxy
pic-proxy        # compatibility alias for `pic --proxy`
pic-proxy attach # shell in the matching project container, or start one
clc-proxy        # Claude Code through the host-side proxy
```

### Crew skill

The project includes [`skills/crew/SKILL.md`](skills/crew/SKILL.md), which lets Pi delegate focused work to visible Herdr role panes such as `scout`, `oracle`, `executor`, and `reviewer`. It works with both `pic` and `pic-proxy`; use it when you want parallel research, planning, implementation, or review from the current Pi session.

The crew extension and skill are **baked into the container image**, so the crew tool is available in every container regardless of your host `~/.pi` contents. The entrypoint only falls back to the image-baked copy when the host did not stage its own, so a locally installed crew still takes precedence.

To also use crew in non-containerized host Pi sessions, install the local extension with:

```bash
npm run install-crew
```

Before implementing any feature or change, the brain uses a Markdown plan named for the change (for example, `feature-to-implement-plan.md`) as the source of truth. It checks a supplied plan against the required template rather than rewriting it. If none is supplied, it drafts one, optionally consulting scout/oracle, and **waits for your explicit confirmation before implementation**. Plans ending in `plan.md` are gitignored. The brain then derives explicit phases from the plan. Standard, localized phases are implemented provisionally and reviewed together at the end; major or cross-cutting phases receive an immediate independent reviewer. After feature review, the workflow runs the installed `parallel-code-review` skill over the complete integration diff and resolves compatible Medium-or-higher findings.

The setup provides one mutation role, `executor`. It does not provide a separate escalation executor; bounded retries reuse the configured executor and unresolved work returns to the user.

Managed direct-mode runs support risk promotion and exact deferred review batches through `crew_control` (`task-promote`, `task-defer`, and `review-batch-create`). Managed durable coordination remains unavailable through `pic-proxy`; use direct `pic` when artifact-gated batch review is required.

### Choosing / changing models

Crew roles and review agents never hardcode a provider or model. Each names an abstract **model tier** (`frontier` / `medium` / `small`) plus a concrete **reasoning** level (`xhigh` / `medium` / `low`). Everything lives in the single **`model-tiers.json`**:
- `models.frontier|medium|small` → the provider/model each tier means for us (currently Opus 5.5 for `frontier`, and Sonnet 5.5 for both `medium` and `small`). **Change which model a crew member uses by editing these three values.**
- `crewRoles.<role>` → the `{ model: <tier>, reasoning: <level>, authority, description }` per crew member (scout, oracle, executor, reviewer).
- `parallelCodeReview.<agent>` → the model tier + reasoning per review agent.

Example: to run everything on your own provider, change only the three `models.*` values. To make the reviewer cheaper, set `crewRoles.reviewer.model` to `medium`; to make it think harder, raise `crewRoles.reviewer.reasoning`. An inline concrete `"model": "provider/x"` override is still honored as an escape hatch.

### Herdr integration

When `pic` or `pic-proxy` is launched inside a Herdr pane, the runner auto-enables Pi status reporting through a host/container socket bridge. No Herdr socket is bind-mounted into the Apple container.

```bash
pic-proxy
# or
herdr agent start "$(basename "$PWD")" --cwd "$PWD" -- pic-proxy
```

The Herdr agent is renamed to the current directory basename by default. Override or disable that with:

```bash
PIC_HERDR_NAME=my-agent pic-proxy
PIC_HERDR_RENAME=0 pic-proxy
PIC_HERDR_BRIDGE=0 pic-proxy   # disable Herdr status bridge
```

Run `herdr integration install pi` on the host once. The entrypoint loads `herdr-agent-state.ts` only when `HERDR_ENV=1`.

Crew children launched from a `pic` or `pic-proxy` brain inherit its proxy mode (`PIC_PROXY_MODE`). Durable/managed crew mode is still unsupported through `pic`/`pic-proxy`. The in-container Herdr bridge exits when its Pi process exits.

The Herdr version baked into the image must match the host (`herdr --version`). The entrypoint warns on a mismatch, which otherwise surfaces as `protocol_mismatch`. After rebuilding the image, running containers from an older image are no longer reused; the log prints `container stop <id>` to stop them. Reused containers (`container exec`) keep `/root/.pi`: skills and extensions are refreshed atomically and the auth mode is reconciled.

#### Crew pane lifecycle

- Every `crew_launch` creates a fresh Herdr pane; panes are never reused. Spawning is serialized per tab, so parallel launches do not squeeze the brain pane.
- Completion is read primarily from the child's Pi session JSONL (Herdr reports its path as `agent_session`). Terminal markers are a wrap-tolerant fallback. `details.extractionSource` is `session` or `terminal` (or `null` when no marker pair was confirmed). Answers are capped at 60,000 characters; `details.childSessionPath` points to the full text.
- Panes of every role, including `executor`, close automatically once the brain has received the result: after the toolResult `message_end` (with `tool_execution_end` as a 30s fallback) plus `teardownGraceMs` (default 5000). `lifecycle.ephemeral` defaults to `true`; pass `ephemeral: false` or set `lifecycle.ephemeral=false` to keep panes.
- The close is graceful (`/quit`, then `herdr pane close`) and checks pane, name, session, and terminal ID first. Incomplete, working, blocked, failed, and timed-out panes are retained for inspection. A stale-pane sweep runs on session start.

#### Context compaction

Pi's native auto-compaction is the compaction mechanism; it runs between turns without aborting. Crew does not enable it. Configure it with:

```bash
npm run configure-compaction              # dry run
npm run configure-compaction -- --write   # apply (run from this repo on the host)
```

This sets `compaction.enabled=true` and a per-model `reserveTokens` equal to 50% of the context window for the tier models and the default model. Options: `--fraction`, `--model`, `--settings`, `--config-cwd`. A `.bak` backup of the settings file is kept. Settings apply to newly started or reloaded Pi sessions; running pic containers keep their staged copy until recreated.

Crew context notices occur at 20% and 50% of the active model's context window (1M tokens when the window is unavailable) and state the real compaction status read from settings (enabled, or disabled with overflow recovery off). The brain can call `self_compact` for its own session; it interrupts the current run, compacts, then automatically resumes the agent. For managed direct-mode children, the brain reads the child's context notification and uses `crew_compact_decide` to approve or decline that exact child's request; only an approved child can call `self_compact` in its own Pi session. Legacy/`pic-proxy` children cannot request authenticated approval, so voluntary compaction is disabled for them; they rely on native auto-compaction only if it is enabled in settings. Pi compaction is lossy; preserve accepted plan, phase, blockers, and evidence references in summary instructions. Compaction does not close Herdr panes.

Crew launches bind a stable launch ID to the child pane and Herdr `agent_session`. The extension keeps controller state, raw Herdr state, managed task state, and completion evidence separate so an idle child is not mistaken for verified completion. Use the `crew_status` tool from the brain or `/crew-status` interactively to inspect running, blocked, timed-out-but-live, lost, replaced, or settled-incomplete children. A compact `crew:` footer indicator appears when work is active or needs attention.

You can publish container ports to the host by passing `-p` or `--publish` arguments:
```bash
clc-proxy -p 5173:5173 -p 3000:3000
```

### Session Isolation

Pi sessions are persisted outside the container and workspace tree. `pic` and
`pic-proxy` bind-mount the host project-scoped session directory directly from:

```text
~/.pi/agent/sessions/<project-namespace>/
```

into `/pi-sessions` in the container, where Pi writes flat UUID-named `.jsonl` session files.
This enables host-side inspection tools like **agentsview** to track token and agent usage
automatically across runs and container reuse with zero manual steps. Read and write access
is limited strictly to the spawning project's session directory: other projects' session
transcripts and namespace directories are excluded from `/host-pi` by construction and remain
inaccessible from inside the container. Concurrent Pi processes within the same project safely
share the directory because session IDs are unique UUIDs.

*Integrity caveat:* Session transcripts are agent-authored, attacker-influenceable data,
not tamper-proof audit logs; any editing role within the project container can write to its
project session directory, and agentsview renders untrusted session content.

Claude Code stores project history under its normal `projects/` layout, but `clc-proxy`
bind-mounts that directory outside the container at:

```text
~/.clc-container/claude-projects/<project>/
```

For convenience, `clc-proxy` also creates this ignored project-local symlink:

```text
./.claude/projects -> ~/.clc-container/claude-projects/<project>/
```


### Mounting multiple directories with `--volume`

You can pass `--volume` arguments to mount additional host directories:
```bash
clc-proxy --volume "../web:/workspace/web"
```

### Config Handling

- **Pi**: a pruned host Pi config tree is staged outside the workspace at
  `~/.pic-container/pi-config/<project>/<launch-instance>/` and mounted at `/host-pi`
  (read-only). Sessions are excluded from the staged tree by construction. The
  entrypoint copies safe config files into `/root/.pi`, while any present `npm`/`git`
  caches are mounted separately to `/host-pi-npm` and `/host-pi-git`.
- **Per-launch staging isolation**: each launch that starts a new container stages into
  its own instance directory under the project staging root, so a second session in the
  same folder can never rewrite a directory that a running container has bind-mounted at
  `/host-pi`. Sharing one staged directory previously caused a concurrent launch to empty
  it, which wiped model and API configuration in the other session. Container reuse
  accepts any instance directory under the project staging root, and stale instances are
  garbage-collected on launch (directories still mounted by a live container, or younger
  than one hour, are always kept).

### Ignoring local auth with an Anthropic key

Pi resolves stored credentials (from `auth.json`) before env keys, so a copied
`auth.json` would shadow `ANTHROPIC_API_KEY`. The container and host both
support an opt-in `--anthropic` (`-a`) mode that ignores local auth:

- **In the container**: `pic --anthropic "prompt"` (or `pic -a`) forwards
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN` from the
  host env into the container and passes `PIC_EXCLUDE_AUTH=1`; `entrypoint.sh`
  then skips copying `~/.pi/agent/auth.json`, so the key wins. Without the flag,
  `pic`/`pic-proxy` run exactly as before and keep using local auth.

- **Source a key without storing it**: when `--anthropic` is passed but no
  `ANTHROPIC_*` key is in the environment, the runner runs the command given by
  the generic `PI_ANTHROPIC_KEY_CMD` env var and uses its stdout as the key
  (e.g. a 1Password lookup). The repo contains only this indirection, never the
  secret or the command itself. Example (in `~/.zshrc`, outside the repo):

  ```bash
  export PI_ANTHROPIC_KEY_CMD='op read --account NFKJESXBABCS5FBEBGKA4ZZ3LQ "op://Employee/Anthropic pi dev key/password"'
  ```

- **On the host** (outside the container), the `pik` shell function (see
  `~/.zshrc`) points `PI_CODING_AGENT_DIR` at `~/.pi-anthropic/agent`, where
  `auth.json` is an empty stub and everything else is symlinked back to
  `~/.pi/agent`. It sources the same `PI_ANTHROPIC_KEY_CMD` (or a set
  `ANTHROPIC_API_KEY`), so `pik "prompt"` also ignores local `auth.json`;
  normal `pi` keeps using it.
- **Claude Code proxy**: host `~/.claude` is mounted read-only at `/host-claude`.
  The entrypoint copies only user-authored config into the persistent, host-backed
  Linux config directory at `~/.clc-container/claude-config`, mounted as
  `/claude-config`: `CLAUDE.md`, `rules`, `settings*.json`, `statusline-command.sh`,
  `commands`, `agents`, `skills`, and `plugins`. It intentionally does not copy
  credentials, history, cache, debug logs, jobs, paste cache, or old projects.
  Run `/login` once in the container; Claude Code persists Linux auth at
  `/claude-config/.credentials.json`. Claude Code project/session history is
  bind-mounted outside the container at `~/.clc-container/claude-projects/<project>`
  via `/claude-config/projects`.


## Test / Debug

Start a shell instead of Pi or Claude Code:
```bash
container volume create "pic-node-modules-$(pwd | shasum | cut -c1-12)" >/dev/null 2>&1 || true
container run -it --memory 4g \
  --volume "$PWD:/workspace/$(basename $PWD)" \
  --mount type=volume,source="pic-node-modules-$(pwd | shasum | cut -c1-12)",target="/workspace/$(basename $PWD)/node_modules" \
  --dns 1.1.1.1 \
  --entrypoint /bin/bash \
  -w "/workspace/$(basename $PWD)" \
  agentic-coding-node:24
```

Smoke test inside the container:
```bash
node --version
npm --version
pnpm --version
fd --version
rg --version
rtk --version
pi --help
claude --version
```

## Public Repo Hygiene

Safe to commit:
- source files, Dockerfile, entrypoint, README, lockfiles
- `Mullvad.md` after keeping it generic and free of account IDs, keys, or personal relay details

Do not commit:
- `.claude/`, `.claude-host-config/`, `.pi/agent/sessions/`, `sessions/`
- `node_modules/`, `.pnpm-store/`
- `CLAUDE.local.md`
- local notes such as `perf-review.md` or `*.local.md`
- Claude tokens, API keys, WireGuard private keys, Mullvad account numbers, or copied auth files

Claude Code sessions are inspectable through the ignored symlink
`./.claude/projects`, but the real data lives under `~/.clc-container/`.

## Image Contents

The custom `node:24-trixie-slim` image includes:
- `@earendil-works/pi-coding-agent` (pinned via the `PI_VERSION` build arg)
- Herdr CLI (pinned and checksum-verified via `HERDR_VERSION` and `HERDR_SHA256_*` build args)
- the `crew` extension and skill, baked in as an image fallback
- `pnpm`
- `fd`
- `ripgrep`
- `rtk` installed under `/root/.local/bin`
- RTK Pi integration loaded from the mounted Pi config, or from the image fallback
- **Claude Code** installed via the Anthropic native installer (`~/.local/bin/claude`)

## Upgrade

Pi is pinned via the `PI_VERSION` build arg in the `Dockerfile`. To upgrade,
bump `ARG PI_VERSION` (or override it at build time) and rebuild:
```bash
container build --dns 1.1.1.1 --build-arg PI_VERSION=0.87.1 -t agentic-coding-node:24 .
```

Herdr is pinned the same way and must match the host `herdr --version`. Take the
checksums from https://herdr.dev/latest.json (`releases.<version>.sha256`):
```bash
container build --dns 1.1.1.1 \
  --build-arg HERDR_VERSION=<v> \
  --build-arg HERDR_SHA256_AARCH64=<sha> \
  --build-arg HERDR_SHA256_X86_64=<sha> \
  -t agentic-coding-node:24 .
```
After a rebuild, stop containers still running the old image (`container stop <id>`).

To rebuild against the pinned version without cache:
```bash
container build --no-cache --dns 1.1.1.1 -t agentic-coding-node:24 .
```

To upgrade Claude Code, rebuild or update within a running container:
```bash
claude update
```

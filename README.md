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
args:
```bash
npm install

node - <<'NODE' &
const ProxyChain = require('proxy-chain');
const server = new ProxyChain.Server({ host: '192.168.64.1', port: 8891 });
server.listen().then(() => console.log('proxy listening on 192.168.64.1:8891'));
process.on('SIGTERM', async () => { await server.close(true); process.exit(0); });
NODE
PID=$!

container build --dns 192.168.64.1 \
  --build-arg HTTP_PROXY=http://192.168.64.1:8891 \
  --build-arg HTTPS_PROXY=http://192.168.64.1:8891 \
  --build-arg http_proxy=http://192.168.64.1:8891 \
  --build-arg https_proxy=http://192.168.64.1:8891 \
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
pic             # Pi with direct networking
pic --proxy     # Pi through the host-side proxy
pic-proxy       # compatibility alias for `pic --proxy`
clc-proxy       # Claude Code through the host-side proxy
```

You can publish container ports to the host by passing `-p` or `--publish` arguments:
```bash
clc-proxy -p 5173:5173 -p 3000:3000
```

### Session Isolation

Pi stores UUID-named sessions under `./.pi/agent/sessions/`; concurrent Pi
processes can safely share that directory. Claude Code stores project history
under its normal `projects/` layout, but `clc-proxy` bind-mounts that directory outside the container at:

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

- **Pi**: host `~/.pi` is mounted at `/host-pi` (read-only). The entrypoint copies
  safe config files into `/root/.pi`, excludes lock/session files, and symlinks
  large directories.
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
- `@earendil-works/pi-coding-agent`
- `pnpm`
- `fd`
- `ripgrep`
- `rtk` installed under `/root/.local/bin`
- RTK Pi integration loaded from the mounted Pi config, or from the image fallback
- **Claude Code** installed via the Anthropic native installer (`~/.local/bin/claude`)

## Upgrade

To upgrade Pi to the latest published npm version, rebuild without cache:
```bash
container build --no-cache --dns 1.1.1.1 -t agentic-coding-node:24 .
```

To upgrade Claude Code, rebuild or update within a running container:
```bash
claude update
```

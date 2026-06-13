# pi-container

Run the Pi coding agent inside an Apple container while editing the current host
project directory. The container mounts the current directory as `/workspace/<basename>`,
uses your host `~/.pi` configuration, and leaves the normal non-containerized
`pi` command untouched.

## Commands

| Command | Use when |
| --- | --- |
| `pic` | Normal containerized Pi session; host `~/.pi` is mounted read-only. |
| `pic-admin` | You need to modify Pi config, for example `pi install`, `pi update`, `/login`, or extension/package changes. |
| `pic-proxy` | A VPN is connected and container networking needs a host-side proxy. |

## Requirements

- macOS 26.x with Apple container installed.
- Apple container system services started.
- Node.js/npm on the host only if you want to use `pic-proxy`.

Install Apple container from:

https://github.com/apple/container/releases

Start the container system:

```bash
container system start
```

## Build the Pi Image

Build the container image:

```bash
container build --dns 1.1.1.1 -t pi-coding-node:24 .
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
  -t pi-coding-node:24 .

kill $PID
```

This is helpful when DNS changes such as `--dns 1.1.1.1` or a local router DNS
still fail because the VPN blocks direct public egress from the builder VM.

## Install the Commands

Add `pic` and `pic-admin` to your shell config, for example `~/.zshrc`:

```zsh
pic() {
  local dir="${PWD##*/}"
  mkdir -p "$PWD/sessions"
  container run -it --memory 4g \
    --volume "$PWD:/workspace/$dir" \
    --mount type=bind,source="$HOME/.pi",target=/host-pi,readonly \
    --dns 1.1.1.1 \
    -w "/workspace/$dir" \
    pi-coding-node:24 --session-dir "/workspace/$dir/sessions"
}

pic-admin() {
  local dir="${PWD##*/}"
  mkdir -p "$PWD/sessions"
  container run -it --memory 4g \
    --volume "$PWD:/workspace/$dir" \
    --mount type=bind,source="$HOME/.pi",target=/root/.pi \
    --dns 1.1.1.1 \
    -w "/workspace/$dir" \
    pi-coding-node:24 --session-dir "/workspace/$dir/sessions"
}
```

To mount additional directories alongside your current project, set the
`PIC_EXTRA_VOLUMES` environment variable with one or more `--volume` specs
separated by spaces before running `pic` or `pic-admin`:

```zsh
PIC_EXTRA_VOLUMES="--volume ../project-web:/workspace/project-web" pic
```

Or in your shell config, extend the function:

```zsh
pic() {
  local dir="${PWD##*/}"
  mkdir -p "$PWD/sessions"
  container run -it --memory 4g \
    --volume "$PWD:/workspace/$dir" \
    ${PIC_EXTRA_VOLUMES:---volume ../project-web:/workspace/project-web --volume ../project-api:/workspace/project-api} \
    --mount type=bind,source="$HOME/.pi",target=/host-pi,readonly \
    --dns 1.1.1.1 \
    -w "/workspace/$dir" \
    pi-coding-node:24 --session-dir "/workspace/$dir/sessions"
}
```

Reload your shell:

```bash
source ~/.zshrc
```

Install `pic-proxy` once from this repo:

```bash
npm install
npm link
```

This exposes `pic-proxy` as an npm-linked executable, so it works regardless of
where this repo was cloned.

## Run

From any project directory:

```bash
pic
```

This creates `./sessions`, mounts the current directory as
`/workspace/<basename>` (e.g., `/workspace/project-core`), mounts host `~/.pi`
read-only at `/host-pi`, and copies safe config into container-local
`/root/.pi`.

When a VPN is connected, you may need to use:

```bash
pic-proxy
```

`pic-proxy` starts a local `proxy-chain` forward proxy on the host bridge
`192.168.64.1:8888`, then starts the same container as `pic` with `HTTP_PROXY`,
`HTTPS_PROXY`, and `ALL_PROXY` set. This avoids changing host `~/.pi` model
configuration.

### Mounting multiple directories with `--volume`

You can pass one or more `--volume` arguments to mount additional host
directories alongside your current project. Each directory is mounted at
`/workspace/<dirname>` using its basename, so you can `cd ../<other-dir>` to
move between them:

```bash
# From ~/projects/project-core/
pic-proxy --volume "../project-web:/workspace/project-web"
```

Inside the container you land in `/workspace/project-core` and can switch
to the other project with `cd ../project-web`.

**No host paths leak into the container.** By using relative paths like
`"../project-web:/workspace/project-web"`, the host side of the bind mount
stays relative; the container only sees the clean `/workspace/*` layout. The
same applies to the primary mount — your current directory is mounted as
`/workspace/<basename>`, not as `/workspace` with the full host path.

When you need to modify Pi configuration:

```bash
pic-admin
```

`pic-admin` mounts host `~/.pi` directly at `/root/.pi`, so use it only for
configuration-changing operations.

## Test / Debug

Equivalent direct command for `pic`:

```bash
container run -it --memory 4g \
  --volume "$PWD:/workspace/$(basename $PWD)" \
  --mount type=bind,source="$HOME/.pi",target=/host-pi,readonly \
  --dns 1.1.1.1 \
  -w "/workspace/$(basename $PWD)" \
  pi-coding-node:24 --session-dir "/workspace/$(basename $PWD)/sessions"
```

Start a shell instead of Pi:

```bash
container run -it --memory 4g \
  --volume "$PWD:/workspace/$(basename $PWD)" \
  --mount type=bind,source="$HOME/.pi",target=/host-pi,readonly \
  --dns 1.1.1.1 \
  --entrypoint /bin/bash \
  -w "/workspace/$(basename $PWD)" \
  pi-coding-node:24
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
```

## Upgrade Pi

The Pi agent is installed into the image at build time. To upgrade it to the
latest published npm version, rebuild without cache:

```bash
container build --no-cache --dns 1.1.1.1 -t pi-coding-node:24 .
```

Verify the version:

```bash
container run --rm --entrypoint /bin/bash pi-coding-node:24 -lc 'pi --version'
```

## Image Contents

The custom `node:24-trixie-slim` image includes:

- `@earendil-works/pi-coding-agent`
- `pnpm`
- `fd`
- `ripgrep`
- `rtk` installed under `/root/.local/bin`
- RTK Pi integration loaded from the mounted Pi config, or from the image fallback

## Pi Config Handling

Normal `pic` and `pic-proxy` runs mount host `~/.pi` read-only at `/host-pi`.
The entrypoint copies small config files into `/root/.pi`, excludes lock/session
files, and symlinks large package directories instead of copying them:

```text
/root/.pi/agent/npm -> /host-pi/agent/npm
/root/.pi/agent/git -> /host-pi/agent/git
```

This keeps startup fast while preserving installed Pi packages/extensions.

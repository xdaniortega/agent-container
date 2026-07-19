#!/bin/sh
set -e

# If the caller provides a real executable, run it directly instead of
# treating the arguments as a Pi prompt. This allows commands like:
#   container run image pandoc README.md --pdf-engine=typst -o README.pdf
if [ -n "${1:-}" ] && [ "${1:-}" != "pi" ] && [ "${1:-}" != "claude" ] && command -v "$1" >/dev/null 2>&1; then
  exec "$@"
fi

case "${1:-}" in
  claude)
    # Claude Code setup
    # Keep Linux-native auth/state in the persistent config volume, but seed only
    # user-authored config from the host. Avoid copying host work/history/cache files.
    claude_config_dir="${CLAUDE_CONFIG_DIR:-/root/.claude}"
    mkdir -p "$claude_config_dir"

    if [ -d /host-claude ]; then
      for item in \
        settings.json \
        settings.local.json \
        statusline-command.sh \
        CLAUDE.md \
        commands \
        agents \
        skills \
        plugins \
        rules
      do
        if [ -e "/host-claude/$item" ]; then
          rm -rf "$claude_config_dir/$item"
          cp -a "/host-claude/$item" "$claude_config_dir/$item"
        fi
      done
    fi

    shift  # remove 'claude' from args
    exec claude "$@"
    ;;
  pi|*)
    # Pi setup (unchanged from pi-container-entrypoint.sh)
    if [ -d /host-pi ]; then
      rm -rf /root/.pi
      mkdir -p /root/.pi
      tar -C /host-pi \
        --exclude='./agent/bin' \
        --exclude='./agent/sessions' \
        --exclude='./agent/npm' \
        --exclude='./agent/git' \
        --exclude='./agent/settings.json.lock' \
        --exclude='./agent/auth.json.lock' \
        -cf - . | tar -C /root/.pi -xf -
    fi

    mkdir -p /root/.pi/agent
    if [ -d /host-pi/agent/npm ]; then
      ln -s /host-pi/agent/npm /root/.pi/agent/npm
    fi
    if [ -d /host-pi/agent/git ]; then
      ln -s /host-pi/agent/git /root/.pi/agent/git
    fi

    if [ -d /host-pi/agent/extensions ]; then
      mkdir -p /root/.pi/agent/extensions
      for extension in /host-pi/agent/extensions/*; do
        [ -e "$extension" ] || continue
        target="/root/.pi/agent/extensions/$(basename "$extension")"
        if [ ! -e "$target" ]; then
          ln -s "$extension" "$target"
        fi
      done
    fi

    should_pnpm_install=false
    if [ "${PIC_PNPM_INSTALL:-1}" != "0" ] && [ -f package.json ] && command -v pnpm >/dev/null 2>&1; then
      if [ -f pnpm-lock.yaml ]; then
        should_pnpm_install=true
      elif command -v node >/dev/null 2>&1 && node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); process.exit(String(pkg.packageManager || '').startsWith('pnpm@') ? 0 : 1)"; then
        should_pnpm_install=true
      fi
    fi

    if [ "$should_pnpm_install" = true ]; then
      echo "[pi-container] approving builds and installing"
      pnpm approve-builds --all
      pnpm install --prefer-offline
    fi

    # If args start with 'pi', shift it off
    if [ "${1:-}" = "pi" ]; then shift; fi

    if [ "${PIC_HERDR_BRIDGE:-0}" = "1" ] && [ -n "${HERDR_SOCKET_PATH:-}" ]; then
      cat > /tmp/pic-herdr-bridge.cjs <<'EOF'
const net = require('node:net');
const fs = require('node:fs');
const socketPath = process.env.HERDR_SOCKET_PATH;
const host = process.env.PIC_HERDR_BRIDGE_HOST || '192.168.64.1';
const port = Number(process.env.PIC_HERDR_BRIDGE_PORT || 0);
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((local) => {
  const remote = net.connect(port, host);
  local.pipe(remote);
  remote.pipe(local);
  const closeBoth = () => { local.destroy(); remote.destroy(); };
  local.on('error', closeBoth);
  remote.on('error', closeBoth);
});
server.on('error', (error) => {
  console.error('[pic-herdr-bridge] ' + (error && error.stack || error));
  process.exit(1);
});
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  console.error('[pic-herdr-bridge] listening on ' + socketPath + ' -> ' + host + ':' + port);
});
EOF
      node /tmp/pic-herdr-bridge.cjs &
      bridge_pid=$!
      trap 'kill "$bridge_pid" 2>/dev/null || true; rm -f "$HERDR_SOCKET_PATH"' EXIT INT TERM
      sleep 0.2
    fi

    if [ ! -f /root/.pi/agent/extensions/rtk.ts ] && [ -f /usr/local/share/pi/extensions/rtk.ts ]; then
      ln -s /usr/local/share/pi/extensions/rtk.ts /root/.pi/agent/extensions/rtk.ts
    fi

    for extension in \
      /root/.pi/agent/extensions/rtk.ts \
      /root/.pi/agent/extensions/herdr-agent-state.ts
    do
      [ -f "$extension" ] || continue
      set -- -e "$extension" "$@"
    done

    exec pi "$@"
    ;;
esac

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
      # Build the exclude list as a single word-split string (no spaces in the
      # patterns). When the runner passes PIC_EXCLUDE_AUTH=1 (an Anthropic key
      # env was provided), also drop auth.json so the env key wins over any
      # stored credential instead of being shadowed by it.
      _pi_excludes="--exclude=./agent/bin --exclude=./agent/sessions --exclude=./agent/npm --exclude=./agent/git --exclude=./agent/skills --exclude=./agent/settings.json.lock --exclude=./agent/auth.json.lock"
      if [ "${PIC_EXCLUDE_AUTH:-0}" = "1" ]; then
        _pi_excludes="$_pi_excludes --exclude=./agent/auth.json"
      fi
      # shellcheck disable=SC2086 # intentional word-splitting into tar args
      tar -C /host-pi $_pi_excludes -cf - . | tar -C /root/.pi -xf -
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

    # Pi skills may live in:
    #   ./skills/<name>                 (versioned project skills, preferred here)
    #   ./.pi/skills/<name>             (Pi project-local convention)
    #   ./.pi/agent/skills/<name>       (legacy compatibility)
    #   ./.pi/host-agent-skills/<name>  (host ~/.pi/agent/skills staged by pic-runner)
    # Pi loads runtime skills from ~/.pi/agent/skills. Materialize skills there
    # at container startup. Precedence is: ./skills > ./.pi/skills >
    # ./.pi/agent/skills > staged host skills.
    mkdir -p /root/.pi/agent/skills

    # Install skills by copying and dereferencing symlinks instead of linking to
    # the source. Host skills are staged by the host-side runner first, because
    # arbitrary host symlink targets are not visible from inside the container.
    install_skill() {
      src="$1"
      dest="$2"
      tmp="$dest.$$"
      lock="$dest.lock"
      if mkdir "$lock" 2>/dev/null; then
        rm -rf "$tmp"
        if cp -aL "$src" "$tmp" 2>/dev/null; then
          rm -rf "$dest"
          if mv "$tmp" "$dest" 2>/dev/null; then
            rmdir "$lock" 2>/dev/null || true
            return 0
          fi
        fi
        rm -rf "$tmp"
        rmdir "$lock" 2>/dev/null || true
        return 1
      fi
      [ -e "$dest" ] || [ -L "$dest" ]
    }

    if [ -d "$PWD/skills" ]; then
      for skill in "$PWD"/skills/*; do
        [ -e "$skill/SKILL.md" ] || continue
        target="/root/.pi/agent/skills/$(basename "$skill")"
        rm -rf "$target"
        install_skill "$skill" "$target"
      done
    fi

    for skill_dir in "$PWD"/.pi/skills "$PWD"/.pi/agent/skills "$PWD"/.pi/host-agent-skills; do
      [ -d "$skill_dir" ] || continue
      for skill in "$skill_dir"/*; do
        [ -e "$skill/SKILL.md" ] || continue
        target="/root/.pi/agent/skills/$(basename "$skill")"
        # If a stale/dangling entry is present, remove it before materializing
        # this accessible skill directory.
        if [ -e "$target" ]; then
          continue
        fi
        if [ -L "$target" ]; then
          rm -rf "$target"
        fi
        install_skill "$skill" "$target"
      done
    done

    should_pnpm_install=false
    if [ "${PIC_PNPM_INSTALL:-1}" != "0" ] && [ -f package.json ] && command -v pnpm >/dev/null 2>&1; then
      if [ -f pnpm-lock.yaml ]; then
        should_pnpm_install=true
      elif command -v node >/dev/null 2>&1 && node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); process.exit(String(pkg.packageManager || '').startsWith('pnpm@') ? 0 : 1)"; then
        should_pnpm_install=true
      fi
    fi

    if [ "$should_pnpm_install" = true ]; then
      echo "[pi-container] pnpm project detected; skipping automatic install"
      echo "[pi-container] run manually if needed: pnpm approve-builds <package> && pnpm install"
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

    for extension in /root/.pi/agent/extensions/rtk.ts; do
      [ -f "$extension" ] || continue
      set -- -e "$extension" "$@"
    done

    if [ "${HERDR_ENV:-}" = "1" ]; then
      for extension in /root/.pi/agent/extensions/herdr-agent-state.ts; do
        [ -f "$extension" ] || continue
        set -- -e "$extension" "$@"
      done
    fi

    exec pi "$@"
    ;;
esac

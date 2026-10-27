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
    # Herdr version diagnostic warning
    if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${PIC_HOST_HERDR_VERSION:-}" ]; then
      container_herdr_raw="$(herdr --version 2>/dev/null || true)"
      container_herdr_version="$(echo "$container_herdr_raw" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
      host_herdr_version="$(echo "$PIC_HOST_HERDR_VERSION" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
      if [ -n "$container_herdr_version" ] && [ -n "$host_herdr_version" ] && [ "$container_herdr_version" != "$host_herdr_version" ]; then
        echo "[pi-container] warning: Herdr version mismatch between host ($host_herdr_version) and container ($container_herdr_version)." >&2
        echo "[pi-container] warning: Crew and Herdr bridge calls may fail with protocol_mismatch." >&2
        echo "[pi-container] warning: Rebuild the container image with: container build --build-arg HERDR_VERSION=$host_herdr_version --build-arg HERDR_SHA256_AARCH64=<sha256> --build-arg HERDR_SHA256_X86_64=<sha256> ... and stop any running containers." >&2
        echo "[pi-container] warning: The sha256 values come from https://herdr.dev/latest.json (releases.$host_herdr_version.sha256); the Dockerfile pins the checksums for its default HERDR_VERSION only." >&2
      fi
    fi

    # Pi setup
    req_auth_mode="included"
    if [ "${PIC_EXCLUDE_AUTH:-0}" = "1" ]; then
      req_auth_mode="excluded"
    fi

    # Atomically (re)write the staging sentinel recording the auth mode.
    write_staged_sentinel() {
      mkdir -p /root/.pi/.staging 2>/dev/null || true
      if printf 'auth=%s\n' "$1" > "/root/.pi/.staging/sentinel.$$" 2>/dev/null \
        && mv -f "/root/.pi/.staging/sentinel.$$" /root/.pi/.pic-staged 2>/dev/null; then
        return 0
      fi
      rm -f "/root/.pi/.staging/sentinel.$$" 2>/dev/null || true
      return 0
    }

    reused=0
    if [ "${PIC_CONTAINER_REUSE:-0}" = "1" ] && [ -f /root/.pi/.pic-staged ]; then
      staged_auth_mode="included"
      if grep -q '^auth=excluded' /root/.pi/.pic-staged 2>/dev/null; then
        staged_auth_mode="excluded"
      fi

      if [ "$req_auth_mode" = "$staged_auth_mode" ]; then
        echo "[pi-container] container reuse: skipping /root/.pi wipe and host-pi re-extraction (auth=$staged_auth_mode)" >&2
        reused=1
      elif [ "$req_auth_mode" = "included" ] && [ "$staged_auth_mode" = "excluded" ]; then
        echo "[pi-container] container reuse: installing auth.json into container previously staged without it" >&2
        auth_ok=1
        if [ -f /host-pi/agent/auth.json ]; then
          auth_ok=0
          mkdir -p /root/.pi/agent /root/.pi/.staging 2>/dev/null || true
          auth_tmp="/root/.pi/.staging/auth.json.tmp.$$"
          if cp -aL /host-pi/agent/auth.json "$auth_tmp" 2>/dev/null && mv -f "$auth_tmp" /root/.pi/agent/auth.json 2>/dev/null; then
            auth_ok=1
          else
            rm -f "$auth_tmp" 2>/dev/null || true
          fi
        fi
        if [ "$auth_ok" = "1" ]; then
          write_staged_sentinel included
        else
          echo "[pi-container] warning: failed to install auth.json; leaving staged auth mode as excluded" >&2
        fi
        reused=1
      elif [ "$req_auth_mode" = "excluded" ] && [ "$staged_auth_mode" = "included" ]; then
        echo "[pi-container] container reuse: removing auth.json from container previously staged with it (auth exclusion requested)" >&2
        mkdir -p /root/.pi/.staging 2>/dev/null || true
        if [ -e /root/.pi/agent/auth.json ] || [ -L /root/.pi/agent/auth.json ]; then
          mv -f /root/.pi/agent/auth.json "/root/.pi/.staging/auth.json.removed.$$" 2>/dev/null || true
          rm -f "/root/.pi/.staging/auth.json.removed.$$" 2>/dev/null || true
        fi
        if [ ! -e /root/.pi/agent/auth.json ] && [ ! -L /root/.pi/agent/auth.json ]; then
          write_staged_sentinel excluded
        else
          echo "[pi-container] warning: failed to remove auth.json; leaving staged auth mode as included" >&2
        fi
        reused=1
      fi
    fi

    if [ "$reused" = "0" ]; then
      if [ -d /host-pi ]; then
        rm -rf /root/.pi
        mkdir -p /root/.pi
        # Build the exclude list as a single word-split string (no spaces in the
        # patterns). When the runner passes PIC_EXCLUDE_AUTH=1 (an Anthropic key
        # env was provided), also drop auth.json so the env key wins over any
        # stored credential instead of being shadowed by it.
        _pi_excludes="--exclude=./agent/bin --exclude=./agent/sessions --exclude=./agent/npm --exclude=./agent/git --exclude=./agent/skills --exclude=./agent/extensions --exclude=./agent/settings.json.lock --exclude=./agent/auth.json.lock"
        if [ "$req_auth_mode" = "excluded" ]; then
          _pi_excludes="$_pi_excludes --exclude=./agent/auth.json"
        fi
        # shellcheck disable=SC2086 # intentional word-splitting into tar args
        tar -C /host-pi $_pi_excludes -cf - . | tar -C /root/.pi -xf -
        write_staged_sentinel "$req_auth_mode"
      fi
    fi

    mkdir -p /root/.pi/agent
    if [ ! -e /root/.pi/agent/npm ] && [ ! -L /root/.pi/agent/npm ]; then
      if [ -d /host-pi-npm ]; then
        ln -s /host-pi-npm /root/.pi/agent/npm
      elif [ -d /host-pi/agent/npm ]; then
        ln -s /host-pi/agent/npm /root/.pi/agent/npm
      fi
    fi
    if [ ! -e /root/.pi/agent/git ] && [ ! -L /root/.pi/agent/git ]; then
      if [ -d /host-pi-git ]; then
        ln -s /host-pi-git /root/.pi/agent/git
      elif [ -d /host-pi/agent/git ]; then
        ln -s /host-pi/agent/git /root/.pi/agent/git
      fi
    fi

    # Atomic install/update function for extensions and skills (keep in sync with
    # INSTALL_PATH_ATOMIC_SH in runner-utils.cjs; a unit test guards drift).
    # Skips identical content, takes a mkdir lock (stale after 10 minutes), stages
    # tmp/trash/lock under /root/.pi/.staging (outside the directories Pi scans),
    # uses mv -T, restores the old destination if the swap fails, tolerates lost
    # races and never aborts the entrypoint.
    # BEGIN install_path_atomic
    install_path_atomic() {
    ia_src="$1"
    ia_dest="$2"
    [ -e "$ia_src" ] || return 0
    if [ -e "$ia_dest" ] && diff -rq "$ia_src" "$ia_dest" >/dev/null 2>&1; then
    return 0
    fi
    ia_root="${PIC_STAGING_ROOT:-/root/.pi/.staging}"
    mkdir -p "$ia_root" "$(dirname "$ia_dest")" 2>/dev/null || return 0
    ia_key="$(printf '%s' "$ia_dest" | tr '/' '_')"
    ia_lock="$ia_root/$ia_key.lock"
    if [ -d "$ia_lock" ] && [ -n "$(find "$ia_lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rm -rf "$ia_lock" 2>/dev/null || true
    fi
    if mkdir "$ia_lock" 2>/dev/null; then
    if [ -e "$ia_dest" ] && diff -rq "$ia_src" "$ia_dest" >/dev/null 2>&1; then
    rmdir "$ia_lock" 2>/dev/null || true
    return 0
    fi
    find "$ia_root" -maxdepth 1 \( -name "$ia_key.tmp.*" -o -name "$ia_key.trash.*" \) -mmin +10 -exec rm -rf {} + 2>/dev/null || true
    ia_tmp="$ia_root/$ia_key.tmp.$$"
    ia_trash="$ia_root/$ia_key.trash.$$"
    rm -rf "$ia_tmp" "$ia_trash" 2>/dev/null || true
    if cp -aL "$ia_src" "$ia_tmp" 2>/dev/null; then
    ia_moved=0
    if [ -e "$ia_dest" ] && mv "$ia_dest" "$ia_trash" 2>/dev/null; then
    ia_moved=1
    fi
    if mv -T "$ia_tmp" "$ia_dest" 2>/dev/null; then
    rm -rf "$ia_trash" 2>/dev/null || true
    else
    if [ "$ia_moved" = "1" ] && [ ! -e "$ia_dest" ]; then
    mv "$ia_trash" "$ia_dest" 2>/dev/null || true
    fi
    rm -rf "$ia_tmp" 2>/dev/null || true
    if [ -e "$ia_dest" ]; then
    rm -rf "$ia_trash" 2>/dev/null || true
    fi
    fi
    else
    rm -rf "$ia_tmp" 2>/dev/null || true
    fi
    rmdir "$ia_lock" 2>/dev/null || true
    fi
    return 0
    }
    # END install_path_atomic

    # Extensions are staged by pic-runner with host symlinks dereferenced.
    # Never link /root/.pi to host-absolute extension paths.
    mkdir -p /root/.pi/agent/extensions
    if [ -d "$PWD/.pi/host-agent-extensions" ]; then
      for extension in "$PWD"/.pi/host-agent-extensions/*; do
        [ -e "$extension" ] || continue
        target="/root/.pi/agent/extensions/$(basename "$extension")"
        install_path_atomic "$extension" "$target"
      done
    fi
    # Fall back to the image-baked crew extension when the host did not stage one.
    # This makes the crew tool available in every container image regardless of
    # the host ~/.pi contents (mirrors the rtk.ts image fallback below).
    if [ ! -d /root/.pi/agent/extensions/crew ] && [ -d /usr/local/share/pi/extensions/crew ]; then
      install_path_atomic /usr/local/share/pi/extensions/crew /root/.pi/agent/extensions/crew
    fi
    if [ -d /root/.pi/agent/extensions/crew ] && [ ! -f /root/.pi/agent/extensions/crew/index.ts ]; then
      echo "[pi-container] fatal: crew extension is not a readable regular file" >&2
      exit 1
    fi
    extension_names=$(find /root/.pi/agent/extensions -maxdepth 2 -type f -print 2>/dev/null | sort | tr '\n' ' ')
    echo "[pi-container] staged extensions: ${extension_names:-none}" >&2
    if [ -f /root/.pi/agent/extensions/crew/index.ts ]; then
      echo "[pi-container] Crew diagnostic: crew_launch registration source is present" >&2
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
    installed_skills=" "

    if [ -d "$PWD/skills" ]; then
      for skill in "$PWD"/skills/*; do
        [ -e "$skill/SKILL.md" ] || continue
        skill_name="$(basename "$skill")"
        target="/root/.pi/agent/skills/$skill_name"
        install_path_atomic "$skill" "$target"
        installed_skills="$installed_skills$skill_name "
      done
    fi

    for skill_dir in "$PWD"/.pi/skills "$PWD"/.pi/agent/skills "$PWD"/.pi/host-agent-skills; do
      [ -d "$skill_dir" ] || continue
      for skill in "$skill_dir"/*; do
        [ -e "$skill/SKILL.md" ] || continue
        skill_name="$(basename "$skill")"
        case "$installed_skills" in
          *" $skill_name "*) continue ;;
        esac
        target="/root/.pi/agent/skills/$skill_name"
        install_path_atomic "$skill" "$target"
        installed_skills="$installed_skills$skill_name "
      done
    done

    # Fall back to the image-baked crew skill when none was materialized above.
    # The crew extension reads model-tiers.json from ~/.pi/agent/skills/crew, so
    # the skill must exist for the baked-in crew tool to resolve model tiers.
    case "$installed_skills" in
      *" crew "*) ;;
      *)
        if [ ! -e /root/.pi/agent/skills/crew/SKILL.md ] && [ -d /usr/local/share/pi/skills/crew ]; then
          install_path_atomic /usr/local/share/pi/skills/crew /root/.pi/agent/skills/crew
        fi
        ;;
    esac

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

function getDefaultGateway() {
  try {
    const route = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of route.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      if (parts[1] !== '00000000') continue;
      const flags = parseInt(parts[3], 16);
      if (Number.isNaN(flags) || (flags & 0x2) === 0) continue;
      const hex = parts[2];
      if (hex && hex.length === 8 && hex !== '00000000') {
        const octets = [
          parseInt(hex.slice(6, 8), 16),
          parseInt(hex.slice(4, 6), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(0, 2), 16),
        ];
        if (octets.every((o) => !Number.isNaN(o))) {
          const ip = octets.join('.');
          if (ip !== '0.0.0.0') {
            return ip;
          }
        }
      }
    }
  } catch {}
  return null;
}

const host = process.env.PIC_HERDR_BRIDGE_HOST || getDefaultGateway() || '192.168.64.1';
const port = Number(process.env.PIC_HERDR_BRIDGE_PORT || 0);
const watchPid = Number(process.env.PIC_BRIDGE_WATCH_PID || 0);
let serverIno = null;

if (watchPid) {
  const watchTimer = setInterval(() => {
    try {
      process.kill(watchPid, 0);
    } catch (err) {
      if (err && err.code === 'ESRCH') {
        clearInterval(watchTimer);
        try {
          if (serverIno && fs.statSync(socketPath).ino === serverIno) {
            fs.unlinkSync(socketPath);
          }
        } catch {}
        process.exit(0);
      }
    }
  }, 2000);
}

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
  try {
    serverIno = fs.statSync(socketPath).ino;
  } catch {}
  fs.chmodSync(socketPath, 0o600);
  console.error('[pic-herdr-bridge] listening on ' + socketPath + ' -> ' + host + ':' + port);
});
EOF
      export PIC_BRIDGE_WATCH_PID=$$
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

    if [ -d /pi-sessions ]; then
      export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-/pi-sessions}"
    fi

    exec pi "$@"
    ;;
esac

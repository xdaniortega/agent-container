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

    if [ ! -f /root/.pi/agent/extensions/rtk.ts ] && [ -f /usr/local/share/pi/extensions/rtk.ts ]; then
      exec pi -e /usr/local/share/pi/extensions/rtk.ts "$@"
    fi

    # If args start with 'pi', shift it off
    if [ "${1:-}" = "pi" ]; then shift; fi
    exec pi "$@"
    ;;
esac

#!/bin/sh
set -e

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

  mkdir -p /root/.pi/agent
  if [ -d /host-pi/agent/npm ]; then
    ln -s /host-pi/agent/npm /root/.pi/agent/npm
  fi
  if [ -d /host-pi/agent/git ]; then
    ln -s /host-pi/agent/git /root/.pi/agent/git
  fi
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
  echo "[pi-container] running pnpm install --prefer-offline"
  pnpm install --prefer-offline
fi

if [ ! -f /root/.pi/agent/extensions/rtk.ts ] && [ -f /usr/local/share/pi/extensions/rtk.ts ]; then
  exec pi -e /usr/local/share/pi/extensions/rtk.ts "$@"
fi

exec pi "$@"

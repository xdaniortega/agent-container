const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const proxyEnvironmentNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

const piPackageJsonPath = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json';
const nodeProxyPreloadSource = [
  'import { createRequire } from "node:module";',
  `const require = createRequire(${JSON.stringify(piPackageJsonPath)});`,
  'const { setGlobalDispatcher, EnvHttpProxyAgent } = require("undici");',
  'setGlobalDispatcher(new EnvHttpProxyAgent());',
].join('');
const nodeProxyPreloadImport = `--import=data:text/javascript,${encodeURIComponent(nodeProxyPreloadSource)}`;

function parseContainerRunnerArgs(cliArgs, { booleanFlags = [] } = {}) {
  const flags = Object.fromEntries(booleanFlags.map(flag => [flag, false]));
  const extraVolumes = [];
  const extraPublish = [];
  const passthroughArgs = [];

  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (booleanFlags.includes(arg)) {
      flags[arg] = true;
    } else if ((arg === '--volume' || arg === '-v') && i + 1 < cliArgs.length) {
      extraVolumes.push(cliArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith('--volume=')) {
      extraVolumes.push(arg.slice(9));
    } else if ((arg === '--publish' || arg === '-p') && i + 1 < cliArgs.length) {
      extraPublish.push(cliArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith('--publish=')) {
      extraPublish.push(arg.slice(10));
    } else if (arg.startsWith('-p') && arg.length > 2) {
      extraPublish.push(arg.slice(2));
    } else {
      passthroughArgs.push(arg);
    }
  }

  return { flags, extraVolumes, extraPublish, passthroughArgs };
}

function proxyEnvironmentArgs(proxyUrl, { enabled = true } = {}) {
  const value = enabled ? proxyUrl : '';
  const args = proxyEnvironmentNames.flatMap(name => ['-e', `${name}=${value}`]);
  if (enabled) {
    // The OpenAI Node SDK/undici fetch stack does not automatically honor
    // HTTP_PROXY/http_proxy. Preload an undici EnvHttpProxyAgent so Pi's
    // custom OpenAI-compatible providers can reach host/VPN-only endpoints.
    args.push('-e', `NODE_OPTIONS=${nodeProxyPreloadImport}`);
  }
  return args;
}

async function startProxy({ host, port, proxyUrl = `http://${host}:${port}`, verbose = false, log, logPrefix = 'proxy' }) {
  const ProxyChain = require('proxy-chain');
  const attachRequestFailedLogger = (server) => {
    server.on('requestFailed', ({ request, error }) => {
      console.error(`[${logPrefix}] request failed ${request?.url || ''}: ${error?.message || error}`);
    });
  };

  const server = new ProxyChain.Server({ host, port, verbose });
  attachRequestFailedLogger(server);

  try {
    await server.listen();
    log(`proxy-chain listening on ${proxyUrl}`);
    return { server, started: true };
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      log(`reusing existing proxy on ${proxyUrl}`);
      return { server: null, started: false };
    }
    if (error && error.code === 'EADDRNOTAVAIL') {
      if (process.env.PIC_ALLOW_WILDCARD_BIND === '1') {
        log(`warning: address ${host} not available, falling back to 0.0.0.0 because PIC_ALLOW_WILDCARD_BIND=1`);
        const fallbackHost = '0.0.0.0';
        const fallbackServer = new ProxyChain.Server({ host: fallbackHost, port, verbose });
        attachRequestFailedLogger(fallbackServer);
        await fallbackServer.listen();
        log(`proxy-chain listening on 0.0.0.0:${port} (configured proxy URL: ${proxyUrl})`);
        return { server: fallbackServer, started: true };
      }
      const msg = `Address ${host} is not available to bind proxy server on port ${port}. Please set PIC_PROXY_HOST (or CLC_PROXY_HOST) to a reachable IP address on this host, or set PIC_ALLOW_WILDCARD_BIND=1 to allow binding to 0.0.0.0.`;
      log(`error: ${msg}`);
      const err = new Error(msg);
      err.code = 'EADDRNOTAVAIL';
      throw err;
    }
    throw error;
  }
}

function runChildProcess(command, args, { cleanup } = {}) {
  const child = spawn(command, args, { stdio: 'inherit' });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', async (code, signal) => {
    if (cleanup) await cleanup();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });

  return child;
}

const PI_CONFIG_PRUNE_PATHS = [
  'agent/bin',
  'agent/sessions',
  'agent/npm',
  'agent/git',
  'agent/skills',
  'agent/extensions',
  'agent/settings.json.lock',
  'agent/auth.json.lock',
  'settings.json.lock',
  'auth.json.lock',
];

function shouldPrunePiConfigPath(relPath) {
  const norm = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  if (!norm || norm === '.') return false;
  const parts = norm.split('/');
  if (parts.includes('sessions')) return true;
  return PI_CONFIG_PRUNE_PATHS.some(p => norm === p || norm.startsWith(p + '/'));
}

function getProjectSessionsNamespace(workdir) {
  const normalized = path.resolve(workdir);
  return `--${normalized.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// Per-launch staged config instances live under the project staging root as
// `<root>/<timestamp>-<pid>-<rand>`. Every launch stages into a *fresh* directory
// so a concurrent session never rewrites a directory that a running container has
// bind-mounted at /host-pi (that clobbering emptied model/auth config).
const STAGED_PI_CONFIG_INSTANCE_RE = /^\d{13,}-\d+-[a-f0-9]{6}$/;
const SENSITIVE_ENV_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD/i;

function redactSensitiveArgs(args) {
  if (!Array.isArray(args)) return [];
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-e' || arg === '--env') {
      result.push(arg);
      if (i + 1 < args.length) {
        const nextArg = String(args[i + 1] ?? '');
        const eqIdx = nextArg.indexOf('=');
        if (eqIdx !== -1) {
          const varName = nextArg.slice(0, eqIdx);
          if (SENSITIVE_ENV_NAME_RE.test(varName)) {
            result.push(`${varName}=[REDACTED]`);
            i += 1;
            continue;
          }
        }
        result.push(nextArg);
        i += 1;
      }
    } else if (typeof arg === 'string' && (arg.startsWith('--env=') || (arg.startsWith('-e') && arg.length > 2))) {
      const prefix = arg.startsWith('--env=') ? '--env=' : '-e';
      const rest = arg.slice(prefix.length);
      const eqIdx = rest.indexOf('=');
      if (eqIdx !== -1) {
        const varName = rest.slice(0, eqIdx);
        if (SENSITIVE_ENV_NAME_RE.test(varName)) {
          result.push(`${prefix}${varName}=[REDACTED]`);
          continue;
        }
      }
      result.push(arg);
    } else {
      result.push(arg);
    }
  }
  return result;
}

function isStagedPiConfigInstanceName(name) {
  return STAGED_PI_CONFIG_INSTANCE_RE.test(String(name || ''));
}

function createStagedPiConfigInstanceDir(rootDir) {
  const suffix = crypto.randomBytes(3).toString('hex');
  return path.join(rootDir, `${Date.now()}-${process.pid}-${suffix}`);
}

function stageHostPiConfig({ homeDir, targetDir, log = () => {} }) {
  const sourceDir = path.join(homeDir, '.pi');
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    return false;
  }

  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const tmpDir = `${targetDir}.tmp.${process.pid}.${Date.now()}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  let trashDir = null;
  try {
    fs.cpSync(sourceDir, tmpDir, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (srcPath) => {
        const relPath = path.relative(sourceDir, srcPath);
        return !shouldPrunePiConfigPath(relPath);
      },
    });
    // Never destroy an existing target before the replacement is in place: move it
    // aside first so a failed swap cannot leave an empty /host-pi mount behind.
    if (fs.existsSync(targetDir)) {
      trashDir = `${targetDir}.trash.${process.pid}.${Date.now()}`;
      fs.renameSync(targetDir, trashDir);
    }
    fs.renameSync(tmpDir, targetDir);
    if (trashDir) {
      try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch {}
    }
    return true;
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (trashDir && fs.existsSync(trashDir) && !fs.existsSync(targetDir)) {
      try { fs.renameSync(trashDir, targetDir); } catch {}
    }
    log(`warning: failed to stage host pi config: ${err.message}`);
    return fs.existsSync(targetDir);
  }
}

// Garbage-collect staged config instances from earlier launches. Directories that
// are still bind-mounted by a live container (keepDirs) and very recent ones
// (younger than minAgeMs, possibly mid-startup) are always preserved.
function pruneStagedPiConfigDirs({ rootDir, keepDirs = [], minAgeMs = 60 * 60 * 1000, now = Date.now(), log = () => {} }) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  const keep = new Set(keepDirs.filter(Boolean).map(dir => path.resolve(dir)));
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    const isInstance = entry.isDirectory() && isStagedPiConfigInstanceName(entry.name);
    const isLeftoverTmp = /\.(tmp|trash)\.\d+\.\d+$/.test(entry.name);
    if (!isInstance && !isLeftoverTmp) continue;
    if (keep.has(path.resolve(fullPath))) continue;
    try {
      const age = now - fs.statSync(fullPath).mtimeMs;
      if (age < minAgeMs) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    } catch (err) {
      log(`warning: failed to prune staged pi config "${fullPath}": ${err.message}`);
    }
  }
  return removed;
}

function buildPicMountArgs({
  workdir,
  workspaceTarget,
  nodeModulesVolume,
  stagedPiHostDir,
  hostSessionsDir,
  containerSessionsDir = '/pi-sessions',
  extraVolumes = [],
  includeHerdrSocket = false,
  herdrSocketVolumeArgs = [],
  extraPublish = [],
  hostNpmDir,
  hostGitDir,
}) {
  const args = [
    '--volume', `${workdir}:${workspaceTarget}`,
    '--mount', `type=volume,source=${nodeModulesVolume},target=${workspaceTarget}/node_modules`,
    ...extraVolumes.flatMap(v => ['--volume', v]),
    ...(includeHerdrSocket ? herdrSocketVolumeArgs : []),
    ...extraPublish.flatMap(p => ['--publish', p]),
    '--mount', `type=bind,source=${stagedPiHostDir},target=/host-pi,readonly`,
    '--mount', `type=bind,source=${hostSessionsDir},target=${containerSessionsDir}`,
  ];
  if (hostNpmDir && fs.existsSync(hostNpmDir)) {
    args.push('--mount', `type=bind,source=${hostNpmDir},target=/host-pi-npm,readonly`);
  }
  if (hostGitDir && fs.existsSync(hostGitDir)) {
    args.push('--mount', `type=bind,source=${hostGitDir},target=/host-pi-git,readonly`);
  }
  return args;
}

function parseContainerNetworkGateway(jsonText) {
  if (typeof jsonText !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed) return null;

  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const isDefault = item.id === 'default'
      || item.configuration?.name === 'default'
      || item.name === 'default';
    if (isDefault) {
      const gateway = item.status?.ipv4Gateway;
      if (typeof gateway === 'string' && gateway.trim()) {
        return gateway.trim();
      }
    }
  }
  return null;
}

function detectContainerGateway({ spawnSyncImpl = spawnSync } = {}) {
  try {
    const res = spawnSyncImpl('container', ['network', 'list', '--format', 'json'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      return parseContainerNetworkGateway(res.stdout);
    }
  } catch {}
  return null;
}

function normalizeDigest(value, { prefixBare = false } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (prefixBare && !trimmed.startsWith('sha256:')) return `sha256:${trimmed}`;
  return trimmed;
}

// Digest of an Apple `container image inspect <ref>` item. Live shape:
//   [{"configuration":{"descriptor":{"digest":"sha256:ee30..."},"name":"..."},"id":"ee30...","variants":[...]}]
// Preference: configuration.descriptor.digest, then id (sha256: prefixed when
// bare), then index.digest.
function parseImageInspectDigest(jsonText) {
  if (typeof jsonText !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const digest = normalizeDigest(item.configuration?.descriptor?.digest)
      || normalizeDigest(item.id, { prefixBare: true })
      || normalizeDigest(item.index?.digest)
      || normalizeDigest(item.configuration?.index?.digest);
    if (digest) return digest;
  }
  return null;
}

// Digest of the image a container was created from, taken from one item of
// `container inspect <id>` output: configuration.image.descriptor.digest
// (falling back to configuration.image.index.digest). Never uses item.id, which
// is the container id.
function parseContainerImageDigest(inspectItem) {
  const image = inspectItem?.configuration?.image;
  if (!image || typeof image !== 'object') return null;
  return normalizeDigest(image.descriptor?.digest) || normalizeDigest(image.index?.digest);
}

// Shell function shared (verbatim, modulo indentation) with entrypoint.sh.
// A drift-guard unit test compares the two. All staging (tmp/trash/lock) lives
// under PIC_STAGING_ROOT (default /root/.pi/.staging), outside the directories
// Pi scans for extensions/skills, on the same filesystem so mv stays atomic.
// The function never fails: a lost race, stale lock or failed swap leaves the
// existing destination intact.
const INSTALL_PATH_ATOMIC_SH = `# BEGIN install_path_atomic
install_path_atomic() {
ia_src="$1"
ia_dest="$2"
[ -e "$ia_src" ] || return 0
if [ -e "$ia_dest" ] && diff -rq "$ia_src" "$ia_dest" >/dev/null 2>&1; then
return 0
fi
ia_root="\${PIC_STAGING_ROOT:-/root/.pi/.staging}"
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
find "$ia_root" -maxdepth 1 \\( -name "$ia_key.tmp.*" -o -name "$ia_key.trash.*" \\) -mmin +10 -exec rm -rf {} + 2>/dev/null || true
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
`;

// Script run inside a reused container (via `sh -lc`) to refresh one staged
// extension. A failed or lost refresh is never fatal by itself: the container
// is only unusable when dest/index.ts is missing afterwards.
function buildExtensionRefreshScript({ src, dest }) {
  const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return [
    INSTALL_PATH_ATOMIC_SH,
    `mkdir -p "$(dirname ${q(dest)})" 2>/dev/null || true`,
    `install_path_atomic ${q(src)} ${q(dest)} || true`,
    `test -f ${q(`${dest}/index.ts`)}`,
  ].join('\n');
}

function cleanStaleDirSiblings(resolvedTarget, maxAgeMs = 10 * 60 * 1000, now = Date.now()) {
  const parentDir = path.dirname(resolvedTarget);
  const baseName = path.basename(resolvedTarget);
  const prefix = `${baseName}.`;
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const rest = entry.name.slice(prefix.length);
      if (!rest.startsWith('tmp.') && !rest.startsWith('trash.')) continue;
      const fullPath = path.join(parentDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function replaceDirAtomically(targetDir, buildIntoTempDirFn, { maxAgeMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const resolvedTarget = path.resolve(targetDir);
  const parentDir = path.dirname(resolvedTarget);
  fs.mkdirSync(parentDir, { recursive: true });

  cleanStaleDirSiblings(resolvedTarget, maxAgeMs, now);

  const nonce = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpDir = `${resolvedTarget}.tmp.${nonce}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let trashDir = null;
  try {
    const result = buildIntoTempDirFn(tmpDir);
    if (fs.existsSync(resolvedTarget)) {
      trashDir = `${resolvedTarget}.trash.${nonce}`;
      try {
        fs.renameSync(resolvedTarget, trashDir);
      } catch (renameErr) {
        if (renameErr && renameErr.code === 'ENOENT') {
          // Another launcher already moved resolvedTarget aside
          trashDir = null;
        } else {
          throw renameErr;
        }
      }
    }
    try {
      fs.renameSync(tmpDir, resolvedTarget);
    } catch (swapErr) {
      if (swapErr && (swapErr.code === 'ENOTEMPTY' || swapErr.code === 'EEXIST') && fs.existsSync(resolvedTarget)) {
        // Another launcher already installed the target directory
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        if (trashDir) {
          try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch {}
        }
        return result;
      }
      throw swapErr;
    }
    if (trashDir) {
      try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch {}
    }
    return result;
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (trashDir && fs.existsSync(trashDir) && !fs.existsSync(resolvedTarget)) {
      try { fs.renameSync(trashDir, resolvedTarget); } catch {}
    }
    if (fs.existsSync(resolvedTarget) && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')) {
      return undefined;
    }
    throw err;
  }
}

module.exports = {
  PI_CONFIG_PRUNE_PATHS,
  INSTALL_PATH_ATOMIC_SH,
  buildExtensionRefreshScript,
  buildPicMountArgs,
  cleanStaleDirSiblings,
  createStagedPiConfigInstanceDir,
  detectContainerGateway,
  getProjectSessionsNamespace,
  isStagedPiConfigInstanceName,
  nodeProxyPreloadImport,
  parseContainerImageDigest,
  parseContainerNetworkGateway,
  parseContainerRunnerArgs,
  parseImageInspectDigest,
  pruneStagedPiConfigDirs,
  proxyEnvironmentArgs,
  proxyEnvironmentNames,
  redactSensitiveArgs,
  replaceDirAtomically,
  runChildProcess,
  shouldPrunePiConfigPath,
  stageHostPiConfig,
  startProxy,
};

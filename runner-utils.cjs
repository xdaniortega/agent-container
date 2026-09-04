const { spawn } = require('node:child_process');
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
      log(`address ${host} not available, falling back to 0.0.0.0`);
      const fallbackHost = '0.0.0.0';
      const fallbackServer = new ProxyChain.Server({ host: fallbackHost, port, verbose });
      attachRequestFailedLogger(fallbackServer);
      await fallbackServer.listen();
      log(`proxy-chain listening on 0.0.0.0:${port} (configured proxy URL: ${proxyUrl})`);
      return { server: fallbackServer, started: true };
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

module.exports = {
  PI_CONFIG_PRUNE_PATHS,
  buildPicMountArgs,
  createStagedPiConfigInstanceDir,
  getProjectSessionsNamespace,
  isStagedPiConfigInstanceName,
  nodeProxyPreloadImport,
  pruneStagedPiConfigDirs,
  parseContainerRunnerArgs,
  proxyEnvironmentArgs,
  proxyEnvironmentNames,
  runChildProcess,
  shouldPrunePiConfigPath,
  stageHostPiConfig,
  startProxy,
};

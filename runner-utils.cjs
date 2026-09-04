const { spawn } = require('node:child_process');
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
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, targetDir);
    return true;
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    log(`warning: failed to stage host pi config: ${err.message}`);
    return fs.existsSync(targetDir);
  }
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
  getProjectSessionsNamespace,
  nodeProxyPreloadImport,
  parseContainerRunnerArgs,
  proxyEnvironmentArgs,
  proxyEnvironmentNames,
  runChildProcess,
  shouldPrunePiConfigPath,
  stageHostPiConfig,
  startProxy,
};

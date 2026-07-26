#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listContainersJson: listContainersJsonWithRecovery } = require('./container-system.cjs');
const {
  parseContainerRunnerArgs,
  proxyEnvironmentArgs: buildProxyEnvironmentArgs,
  runChildProcess,
  startProxy: startProxyWithFallback,
} = require('./runner-utils.cjs');

const host = process.env.PIC_PROXY_HOST || '192.168.64.1';
const port = Number(process.env.PIC_PROXY_PORT || 8888);
const proxyUrl = `http://${host}:${port}`;
const verbose = process.env.PIC_PROXY_VERBOSE === '1';
const workdir = process.env.PIC_WORKDIR || process.cwd();
const home = process.env.HOME;
const cliArgs = process.argv.slice(2);
let proxyEnabled = process.env.PIC_PROXY_MODE === '1';
const commandName = process.env.PIC_COMMAND_NAME || 'pic';
if (process.env.HERDR_ENV === '1' && !process.env.HERDR_AGENT) {
  process.env.HERDR_AGENT = 'pi';
}

// Extract runner-level --proxy, --volume, and --publish/-p arguments; pass the rest to Pi.
const parsedArgs = parseContainerRunnerArgs(cliArgs, { booleanFlags: ['--proxy'] });
if (parsedArgs.flags['--proxy']) proxyEnabled = true;
const { extraVolumes, extraPublish } = parsedArgs;
const attachMode = parsedArgs.passthroughArgs[0] === 'attach';
const extraPiArgs = attachMode ? parsedArgs.passthroughArgs.slice(1) : parsedArgs.passthroughArgs;

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;
const volumeSuffix = crypto.createHash('sha1').update(workdir).digest('hex').slice(0, 12);
const volumeBasename = dirBasename.replace(/[^a-zA-Z0-9_.-]/g, '-');
const nodeModulesVolume = `pic-${volumeBasename}-${volumeSuffix}-node-modules`;

// Session directory — pi writes UUID-named session files, no hash needed for isolation
// Two pi processes in the same container won't collide because session IDs are UUIDs.
const sessionDir = `${workspaceTarget}/.pi/agent/sessions`;
const herdrEnvironmentNames = ['HERDR_ENV', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_AGENT'];
const herdrSocketMountEnabled = process.env.PIC_HERDR_SOCKET_MOUNT === '1';
const herdrSocketPath = process.env.HERDR_SOCKET_PATH || '';
const herdrSocketDir = herdrSocketMountEnabled && herdrSocketPath ? path.dirname(herdrSocketPath) : '';
const herdrSocketBasename = herdrSocketMountEnabled && herdrSocketPath ? path.basename(herdrSocketPath) : '';
const herdrSocketMountTarget = '/herdr-socket';
const herdrSocketContainerPath = herdrSocketMountEnabled && herdrSocketPath ? `${herdrSocketMountTarget}/${herdrSocketBasename}` : '';
const herdrBridgeEnv = process.env.PIC_HERDR_BRIDGE;
const herdrSessionDetected = process.env.HERDR_ENV === '1'
  && Boolean(herdrSocketPath)
  && Boolean(process.env.HERDR_PANE_ID)
  && fs.existsSync(herdrSocketPath);
const herdrBridgeEnabled = herdrBridgeEnv === '1' || (herdrBridgeEnv !== '0' && herdrSessionDetected);
const herdrBridgeHost = process.env.PIC_HERDR_BRIDGE_HOST || host;
const herdrBridgeRequestedPort = Number(process.env.PIC_HERDR_BRIDGE_PORT || 0);
const herdrBridgeSocketPath = `/tmp/herdr-${String(process.env.HERDR_PANE_ID || 'pane').replace(/[^a-zA-Z0-9_.-]/g, '-')}.sock`;

function proxyEnvironmentArgs() {
  return buildProxyEnvironmentArgs(proxyUrl, { enabled: proxyEnabled });
}

function herdrEnvironmentArgs() {
  const args = [];
  for (const name of herdrEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) args.push('-e', `${name}=${value}`);
  }
  if (herdrBridgeEnabled) {
    args.push('-e', `HERDR_SOCKET_PATH=${herdrBridgeSocketPath}`);
  } else if (herdrSocketContainerPath) {
    args.push('-e', `HERDR_SOCKET_PATH=${herdrSocketContainerPath}`);
  } else if (process.env.HERDR_SOCKET_PATH && herdrSocketMountEnabled) {
    args.push('-e', `HERDR_SOCKET_PATH=${process.env.HERDR_SOCKET_PATH}`);
  }
  return args;
}

function herdrBridgeEnvironmentArgs(herdrBridge) {
  if (!herdrBridge.started) return [];
  return [
    '-e', 'PIC_HERDR_BRIDGE=1',
    '-e', `PIC_HERDR_BRIDGE_HOST=${herdrBridgeHost}`,
    '-e', `PIC_HERDR_BRIDGE_PORT=${herdrBridge.port}`,
  ];
}

function herdrSocketVolumeArgs() {
  if (!herdrSocketMountEnabled || !herdrSocketDir) return [];
  return ['--volume', `${herdrSocketDir}:${herdrSocketMountTarget}`];
}

function log(message) {
  console.log(`[${commandName}] ${message}`);
}

function maybeRenameHerdrAgent() {
  if (process.env.PIC_HERDR_RENAME === '0') return;
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID) return;
  const name = process.env.PIC_HERDR_NAME || dirBasename;
  if (!name) return;
  const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
  const result = spawnSync(herdrBin, ['agent', 'rename', process.env.HERDR_PANE_ID, name], {
    stdio: verbose ? 'inherit' : 'ignore',
  });
  if (verbose && result.status !== 0) {
    log(`warning: failed to rename Herdr agent ${process.env.HERDR_PANE_ID} to "${name}"`);
  }
}
async function startProxy() {
  return startProxyWithFallback({ host, port, proxyUrl, verbose, log, logPrefix: commandName });
}

function startHerdrHostBridge() {
  if (!herdrBridgeEnabled) return Promise.resolve({ server: null, started: false, port: null });
  if (!herdrSocketPath) throw new Error('PIC_HERDR_BRIDGE=1 requires HERDR_SOCKET_PATH to be set by Herdr');

  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((tcpSocket) => {
      const unixSocket = net.connect({ path: herdrSocketPath });
      sockets.add(tcpSocket);
      sockets.add(unixSocket);
      tcpSocket.pipe(unixSocket);
      unixSocket.pipe(tcpSocket);

      const closeBoth = () => {
        sockets.delete(tcpSocket);
        sockets.delete(unixSocket);
        tcpSocket.destroy();
        unixSocket.destroy();
      };
      tcpSocket.on('error', closeBoth);
      unixSocket.on('error', closeBoth);
      tcpSocket.on('close', closeBoth);
      unixSocket.on('close', closeBoth);
    });

    const listen = (listenHost, advertisedHost = herdrBridgeHost) => {
      server.listen(herdrBridgeRequestedPort, listenHost, () => {
        server.removeAllListeners('error');
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : herdrBridgeRequestedPort;
        const suffix = listenHost === advertisedHost ? '' : ` (advertised to container as ${advertisedHost}:${actualPort})`;
        log(`Herdr bridge listening on ${listenHost}:${actualPort} -> ${herdrSocketPath}${suffix}`);
        resolve({ server, sockets, started: true, port: actualPort });
      });
    };

    server.once('error', (error) => {
      if (error && error.code === 'EADDRNOTAVAIL' && herdrBridgeHost !== '0.0.0.0') {
        log(`Herdr bridge address ${herdrBridgeHost} is not available, falling back to 0.0.0.0`);
        listen('0.0.0.0', herdrBridgeHost);
      } else {
        reject(error);
      }
    });

    listen(herdrBridgeHost);
  });
}

function stopServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function interactiveContainerArgs() {
  return process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : [];
}

function warnIgnoredRunOnlyArgs(containerId) {
  if (extraVolumes.length > 0) {
    log(`warning: extra --volume arguments are ignored when reusing container "${containerId}"`);
  }
  if (extraPublish.length > 0) {
    log(`warning: extra --publish arguments are ignored when reusing container "${containerId}"`);
  }
}

function containerExecArgs(containerId, commandArgs, { envArgs = [] } = {}) {
  return [
    'exec',
    ...interactiveContainerArgs(),
    '-w', workspaceTarget,
    ...envArgs,
    containerId,
    ...commandArgs,
  ];
}

function containerRunArgs(commandArgs, { envArgs = [], includeHerdrSocket = false } = {}) {
  return [
    'run', '--rm', ...interactiveContainerArgs(), '--memory', '4g',
    '--volume', `${workdir}:${workspaceTarget}`,
    '--mount', `type=volume,source=${nodeModulesVolume},target=${workspaceTarget}/node_modules`,
    ...extraVolumes.flatMap(v => ['--volume', v]),
    ...(includeHerdrSocket ? herdrSocketVolumeArgs() : []),
    ...extraPublish.flatMap(p => ['--publish', p]),
    '--mount', `type=bind,source=${path.join(home, '.pi')},target=/host-pi,readonly`,
    '--dns', '1.1.1.1',
    ...envArgs,
    '-w', workspaceTarget,
    'agentic-coding-node:24',
    ...commandArgs,
  ];
}

function containerRunPiCommand(piArgs) {
  return ['pi', ...piArgs];
}

function containerExecPiCommand(piArgs) {
  return ['entrypoint', 'pi', ...piArgs];
}

function listContainersJson() {
  return listContainersJsonWithRecovery({ log });
}
// Check if a running container already has workdir mounted as a virtiofs share
function findContainerWithMount(workdirPath) {
  // Normalize the workdir path for comparison
  const normalizedWorkdir = path.resolve(workdirPath);

  log(`checking for running container with mount source "${normalizedWorkdir}"`);

  const listResult = listContainersJson();

  if (listResult.status !== 0) {
    log(`container list failed (exit ${listResult.status}), will start a new container`);
    return null;
  }

  let containers;
  try {
    containers = JSON.parse(listResult.stdout);
    if (!Array.isArray(containers)) {
      // Single object when only one container
      containers = [containers];
    }
  } catch {
    log('failed to parse container list output, will start a new container');
    return null;
  }

  for (const container of containers) {
    const containerId = container.configuration?.id;
    if (!containerId) continue;

    // Inspect this container to get full mount details
    const inspectResult = spawnSync('container', ['inspect', containerId], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf-8',
    });

    if (inspectResult.status !== 0) continue;

    let detail;
    try {
      detail = JSON.parse(inspectResult.stdout);
      // inspect returns an array (one element per container)
      const items = Array.isArray(detail) ? detail : [detail];
      for (const item of items) {
        if (!item.configuration) continue;
        const image = item.configuration.image;
        const imageName = typeof image === 'string'
          ? image
          : image?.reference || image?.descriptor?.annotations?.['com.apple.containerization.image.name'] || '';
        if (!imageName.includes('agentic-coding')) {
          log(`container "${containerId}" uses image "${imageName || 'unknown'}", will not reuse`);
          continue;
        }
        let hasWorkdirMount = false;
        let hasPiConfigMount = false;
        let hasNodeModulesMount = false;
        let hasHerdrSocketMount = !herdrSocketDir;
        for (const mount of item.configuration.mounts || []) {
          const mountTarget = mount.target || mount.destination || mount.mountpoint || mount.mountPoint;
          const mountSourcePath = mount.source ? path.resolve(mount.source) : '';
          const mountSourceName = String(mount.type?.volume?.name || mount.name || mount.source || '');
          if (mount.type === 'virtiofs' || mount.type?.virtiofs !== undefined) {
            if (mountSourcePath === normalizedWorkdir && mountTarget === workspaceTarget) {
              hasWorkdirMount = true;
            }
            if (mountSourcePath === path.resolve(home, '.pi') && mountTarget === '/host-pi') {
              hasPiConfigMount = true;
            }
          }
            if (herdrSocketDir && mountSourcePath === path.resolve(herdrSocketDir) && mountTarget === herdrSocketMountTarget) {
              hasHerdrSocketMount = true;
            }
          if (mountTarget === `${workspaceTarget}/node_modules` && mountSourceName.includes(nodeModulesVolume)) {
            hasNodeModulesMount = true;
          }
        }
        if (hasWorkdirMount && hasPiConfigMount && hasNodeModulesMount && hasHerdrSocketMount) {
          log(`found compatible running container "${containerId}" with ${workspaceTarget} mounted`);
          return containerId;
        }
        if (hasWorkdirMount) {
          log(`container "${containerId}" has the workdir mounted but is missing current Pi config/node_modules/Herdr socket mounts; will not reuse`);
        }
      }
    } catch (error) {
      log(`failed to inspect container "${containerId}": ${error?.message || error}`);
      continue;
    }
  }

  return null;
}

async function main() {
  if (!home) throw new Error('HOME is not set');

  fs.mkdirSync(path.join(workdir, '.pi', 'agent', 'sessions'), { recursive: true });

  maybeRenameHerdrAgent();

  // Check if a container is already running with our workdir mounted
  const existingContainerId = findContainerWithMount(workdir);

  if (existingContainerId) {
    // Volume is already created by the existing container — skip creation
    log(`reusing container "${existingContainerId}" via exec`);
  } else {
    spawnSync('container', ['volume', 'create', nodeModulesVolume], { stdio: verbose ? 'inherit' : 'ignore' });
  }

  const proxy = proxyEnabled
    ? await startProxy()
    : { server: null, started: false };
  const herdrBridge = await startHerdrHostBridge();
  if (!proxyEnabled) log('proxy disabled; clearing proxy environment for the Pi process');
  let cleanedUp = false;

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (proxy.started && proxy.server) {
      log('stopping proxy-chain');
      await proxy.server.close(true);
    }
    if (herdrBridge.started && herdrBridge.server) {
      log('stopping Herdr bridge');
      await stopServer(herdrBridge.server, herdrBridge.sockets);
    }
  }

  if (attachMode) {
    const shellArgs = extraPiArgs.length > 0 ? extraPiArgs : ['/bin/bash'];
    const envArgs = proxyEnvironmentArgs();

    if (existingContainerId) {
      warnIgnoredRunOnlyArgs(existingContainerId);
      const args = containerExecArgs(existingContainerId, shellArgs, { envArgs });

      log(`attach: container exec ${existingContainerId} ${shellArgs.join(' ')}`);
      runChildProcess('container', args, { cleanup });
      return;
    }

    const args = containerRunArgs(shellArgs, { envArgs });

    log(`attach: starting shell in new container at ${workspaceTarget}`);
    runChildProcess('container', args, { cleanup });
    return;
  }

  // Build the pi args (same for both run and exec)
  const piArgs = [
    '--session-dir', sessionDir,
    ...extraPiArgs,
  ];

  if (existingContainerId) {
    // Warn if extra volumes/publish were requested — they can't be applied via exec
    warnIgnoredRunOnlyArgs(existingContainerId);

    const commandArgs = containerExecPiCommand(piArgs);
    const args = containerExecArgs(existingContainerId, commandArgs, {
      envArgs: [
        ...proxyEnvironmentArgs(),
        ...herdrEnvironmentArgs(),
        ...herdrBridgeEnvironmentArgs(herdrBridge),
      ],
    });

    log(`exec: container ${args.slice(1, -piArgs.length - 1).join(' ')} ... pi --session-dir ...`);
    runChildProcess('container', args, { cleanup });
  } else {
    const args = containerRunArgs(containerRunPiCommand(piArgs), {
      includeHerdrSocket: true,
      envArgs: [
        ...proxyEnvironmentArgs(),
        ...herdrEnvironmentArgs(),
        ...herdrBridgeEnvironmentArgs(herdrBridge),
      ],
    });

    runChildProcess('container', args, { cleanup });
  }
}

main().catch((error) => {
  console.error(`[${commandName}] ${error.stack || error.message || error}`);
  process.exit(1);
});

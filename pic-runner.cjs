#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ProxyChain = require('proxy-chain');

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
const extraVolumes = [];
const extraPublish = [];
const extraPiArgs = [];
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if (arg === '--proxy') {
    proxyEnabled = true;
  } else if ((arg === '--volume' || arg === '-v') && i + 1 < cliArgs.length) {
    extraVolumes.push(cliArgs[i + 1]);
    i++; // skip the value
  } else if (arg.startsWith('--volume=')) {
    extraVolumes.push(arg.slice(9));
  } else if ((arg === '--publish' || arg === '-p') && i + 1 < cliArgs.length) {
    extraPublish.push(cliArgs[i + 1]);
    i++; // skip the value
  } else if (arg.startsWith('--publish=')) {
    extraPublish.push(arg.slice(10));
  } else if (arg.startsWith('-p') && arg.length > 2) {
    // -p5173:5173 (no space variant)
    extraPublish.push(arg.slice(2));
  } else {
    extraPiArgs.push(arg);
  }
}

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;
const volumeSuffix = crypto.createHash('sha1').update(workdir).digest('hex').slice(0, 12);
const volumeBasename = dirBasename.replace(/[^a-zA-Z0-9_.-]/g, '-');
const nodeModulesVolume = `pic-${volumeBasename}-${volumeSuffix}-node-modules`;

// Session directory — pi writes UUID-named session files, no hash needed for isolation
// Two pi processes in the same container won't collide because session IDs are UUIDs.
const sessionDir = `${workspaceTarget}/.pi/agent/sessions`;
const proxyEnvironmentNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const herdrEnvironmentNames = ['HERDR_ENV', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_AGENT'];
const herdrSocketMountEnabled = process.env.PIC_HERDR_SOCKET_MOUNT === '1';
const herdrSocketPath = process.env.HERDR_SOCKET_PATH || '';
const herdrSocketDir = herdrSocketMountEnabled && herdrSocketPath ? path.dirname(herdrSocketPath) : '';
const herdrSocketBasename = herdrSocketMountEnabled && herdrSocketPath ? path.basename(herdrSocketPath) : '';
const herdrSocketMountTarget = '/herdr-socket';
const herdrSocketContainerPath = herdrSocketMountEnabled && herdrSocketPath ? `${herdrSocketMountTarget}/${herdrSocketBasename}` : '';
const herdrBridgeEnv = process.env.PIC_HERDR_BRIDGE;
const herdrBridgeEnabled = herdrBridgeEnv === '1' || (herdrBridgeEnv !== '0' && process.env.HERDR_ENV === '1' && Boolean(herdrSocketPath) && Boolean(process.env.HERDR_PANE_ID));
const herdrBridgeHost = process.env.PIC_HERDR_BRIDGE_HOST || host;
const herdrBridgeRequestedPort = Number(process.env.PIC_HERDR_BRIDGE_PORT || 0);
const herdrBridgeSocketPath = `/tmp/herdr-${String(process.env.HERDR_PANE_ID || 'pane').replace(/[^a-zA-Z0-9_.-]/g, '-')}.sock`;

function proxyEnvironmentArgs() {
  const value = proxyEnabled ? proxyUrl : '';
  return proxyEnvironmentNames.flatMap(name => ['-e', `${name}=${value}`]);
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
  const server = new ProxyChain.Server({ host, port, verbose });
  server.on('requestFailed', ({ request, error }) => {
    console.error(`[${commandName}] request failed ${request?.url || ''}: ${error?.message || error}`);
  });

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
      fallbackServer.on('requestFailed', ({ request, error: reqErr }) => {
        console.error(`[${commandName}] request failed ${request?.url || ''}: ${reqErr?.message || reqErr}`);
      });
      await fallbackServer.listen();
      log(`proxy-chain listening on 0.0.0.0:${port} (configured proxy URL: ${proxyUrl})`);
      return { server: fallbackServer, started: true };
    }
    throw error;
  }
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

    server.once('error', reject);
    server.listen(herdrBridgeRequestedPort, herdrBridgeHost, () => {
      server.off('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : herdrBridgeRequestedPort;
      log(`Herdr bridge listening on ${herdrBridgeHost}:${actualPort} -> ${herdrSocketPath}`);
      resolve({ server, sockets, started: true, port: actualPort });
    });
  });
}

function stopServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function containerHerdrBridgeScript(bridgePort) {
  return `
set -e
cat > /tmp/pic-herdr-bridge.cjs <<'EOF'
const net = require('node:net');
const fs = require('node:fs');
const socketPath = process.env.HERDR_SOCKET_PATH || '${herdrBridgeSocketPath}';
const host = process.env.PIC_HERDR_BRIDGE_HOST || '${herdrBridgeHost}';
const port = Number(process.env.PIC_HERDR_BRIDGE_PORT || '${bridgePort}');
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

if [ ! -f /root/.pi/agent/extensions/rtk.ts ] && [ -f /usr/local/share/pi/extensions/rtk.ts ]; then
  ln -s /usr/local/share/pi/extensions/rtk.ts /root/.pi/agent/extensions/rtk.ts
fi

for extension in /root/.pi/agent/extensions/rtk.ts; do
  [ -f "$extension" ] || continue
  set -- -e "$extension" "$@"
done

if [ "\${HERDR_ENV:-}" = "1" ]; then
  for extension in /root/.pi/agent/extensions/herdr-agent-state.ts; do
    [ -f "$extension" ] || continue
    set -- -e "$extension" "$@"
  done
fi

exec pi "$@"
`;
}

function containerPiCommand(piArgs, herdrBridge, useEntrypoint = false) {
  if (!herdrBridge.started || useEntrypoint) return ['pi', ...piArgs];
  return ['sh', '-lc', containerHerdrBridgeScript(herdrBridge.port), 'pic-herdr-entrypoint', ...piArgs];
}

// Check if a running container already has workdir mounted as a virtiofs share
function findContainerWithMount(workdirPath) {
  // Normalize the workdir path for comparison
  const normalizedWorkdir = path.resolve(workdirPath);

  log(`checking for running container with mount source "${normalizedWorkdir}"`);

  // List running containers as JSON
  const listResult = spawnSync('container', ['list', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf-8',
  });

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

  // Build the pi args (same for both run and exec)
  const piArgs = [
    '--session-dir', sessionDir,
    ...extraPiArgs,
  ];

  if (existingContainerId) {
    // Warn if extra volumes/publish were requested — they can't be applied via exec
    if (extraVolumes.length > 0) {
      log(`warning: extra --volume arguments are ignored when reusing container "${existingContainerId}"`);
    }
    if (extraPublish.length > 0) {
      log(`warning: extra --publish arguments are ignored when reusing container "${existingContainerId}"`);
    }

    const args = [
      'exec',
      ...(process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : []),
      '-w', workspaceTarget,
      ...proxyEnvironmentArgs(),
      ...herdrEnvironmentArgs(),
      ...herdrBridgeEnvironmentArgs(herdrBridge),
      existingContainerId,
      ...containerPiCommand(piArgs, herdrBridge, false),
    ];

    log(`exec: container ${args.slice(1, -piArgs.length - 1).join(' ')} ... pi --session-dir ...`);
    const child = spawn('container', args, { stdio: 'inherit' });

    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', () => forwardSignal('SIGINT'));
    process.once('SIGTERM', () => forwardSignal('SIGTERM'));

    child.on('exit', async (code, signal) => {
      await cleanup();
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
  } else {
    const args = [
      'run', '--rm', ...(process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : []), '--memory', '4g',
      '--volume', `${workdir}:${workspaceTarget}`,
      '--mount', `type=volume,source=${nodeModulesVolume},target=${workspaceTarget}/node_modules`,
      ...extraVolumes.flatMap(v => ['--volume', v]),
      ...herdrSocketVolumeArgs(),
      ...extraPublish.flatMap(p => ['--publish', p]),
      '--mount', `type=bind,source=${path.join(home, '.pi')},target=/host-pi,readonly`,
      '--dns', '1.1.1.1',
      ...proxyEnvironmentArgs(),
      ...herdrEnvironmentArgs(),
      ...herdrBridgeEnvironmentArgs(herdrBridge),
      '-w', workspaceTarget,
      'agentic-coding-node:24',
      ...containerPiCommand(piArgs, herdrBridge, true),
    ];

    const child = spawn('container', args, { stdio: 'inherit' });

    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', () => forwardSignal('SIGINT'));
    process.once('SIGTERM', () => forwardSignal('SIGTERM'));

    child.on('exit', async (code, signal) => {
      await cleanup();
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
  }
}

main().catch((error) => {
  console.error(`[${commandName}] ${error.stack || error.message || error}`);
  process.exit(1);
});

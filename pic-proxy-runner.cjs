#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
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

// Extract --volume, --publish/-p arguments from CLI args, the rest pass through to pi
const extraVolumes = [];
const extraPublish = [];
const extraPiArgs = [];
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if ((arg === '--volume' || arg === '-v') && i + 1 < cliArgs.length) {
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

function log(message) {
  console.log(`[pic-proxy] ${message}`);
}

async function startProxy() {
  const server = new ProxyChain.Server({ host, port, verbose });
  server.on('requestFailed', ({ request, error }) => {
    console.error(`[pic-proxy] request failed ${request?.url || ''}: ${error?.message || error}`);
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
        console.error(`[pic-proxy] request failed ${request?.url || ''}: ${reqErr?.message || reqErr}`);
      });
      await fallbackServer.listen();
      log(`proxy-chain listening on 0.0.0.0:${port} (configured proxy URL: ${proxyUrl})`);
      return { server: fallbackServer, started: true };
    }
    throw error;
  }
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
        for (const mount of item.configuration.mounts || []) {
          // Mount type "virtiofs" means a host directory bind mount
          if (mount.type === 'virtiofs' || mount.type?.virtiofs !== undefined) {
            // Resolve the mount source relative to the host
            const mountSource = path.resolve(mount.source);
            if (mountSource === normalizedWorkdir) {
              log(`found running container "${containerId}" with ${workspaceTarget} mounted`);
              return containerId;
            }
          }
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

  // Check if a container is already running with our workdir mounted
  const existingContainerId = findContainerWithMount(workdir);

  if (existingContainerId) {
    // Volume is already created by the existing container — skip creation
    log(`reusing container "${existingContainerId}" via exec`);
  } else {
    spawnSync('container', ['volume', 'create', nodeModulesVolume], { stdio: verbose ? 'inherit' : 'ignore' });
  }

  const proxy = await startProxy();
  let cleanedUp = false;

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (proxy.started && proxy.server) {
      log('stopping proxy-chain');
      await proxy.server.close(true);
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
      '-e', `HTTP_PROXY=${proxyUrl}`,
      '-e', `HTTPS_PROXY=${proxyUrl}`,
      '-e', `ALL_PROXY=${proxyUrl}`,
      '-e', `http_proxy=${proxyUrl}`,
      '-e', `https_proxy=${proxyUrl}`,
      '-e', `all_proxy=${proxyUrl}`,
      existingContainerId,
      'pi',
      ...piArgs,
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
      ...extraPublish.flatMap(p => ['--publish', p]),
      '--mount', `type=bind,source=${path.join(home, '.pi')},target=/host-pi,readonly`,
      '--dns', '1.1.1.1',
      '-e', `HTTP_PROXY=${proxyUrl}`,
      '-e', `HTTPS_PROXY=${proxyUrl}`,
      '-e', `ALL_PROXY=${proxyUrl}`,
      '-e', `http_proxy=${proxyUrl}`,
      '-e', `https_proxy=${proxyUrl}`,
      '-e', `all_proxy=${proxyUrl}`,
      '-w', workspaceTarget,
      'agentic-coding-node:24',
      ...piArgs,
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
  console.error(`[pic-proxy] ${error.stack || error.message || error}`);
  process.exit(1);
});

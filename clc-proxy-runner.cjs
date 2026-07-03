#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ProxyChain = require('proxy-chain');

const host = process.env.CLC_PROXY_HOST || '192.168.64.1';
const port = Number(process.env.CLC_PROXY_PORT || 8888);
const proxyUrl = `http://${host}:${port}`;
const verbose = process.env.CLC_PROXY_VERBOSE === '1';
const workdir = process.env.CLC_WORKDIR || process.cwd();
const home = process.env.HOME;
const cliArgs = process.argv.slice(2);

// Extract --volume, --publish/-p arguments from CLI args, the rest pass through to claude
const extraVolumes = [];
const extraPublish = [];
const extraClaudeArgs = [];
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if ((arg === '--volume' || arg === '-v') && i + 1 < cliArgs.length) {
    extraVolumes.push(cliArgs[i + 1]);
    i++;
  } else if (arg.startsWith('--volume=')) {
    extraVolumes.push(arg.slice(9));
  } else if ((arg === '--publish' || arg === '-p') && i + 1 < cliArgs.length) {
    extraPublish.push(cliArgs[i + 1]);
    i++;
  } else if (arg.startsWith('--publish=')) {
    extraPublish.push(arg.slice(10));
  } else if (arg.startsWith('-p') && arg.length > 2) {
    extraPublish.push(arg.slice(2));
  } else {
    extraClaudeArgs.push(arg);
  }
}

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;
const volumeSuffix = crypto.createHash('sha1').update(workdir).digest('hex').slice(0, 12);
const volumeBasename = dirBasename.replace(/[^a-zA-Z0-9_.-]/g, '-');
const nodeModulesVolume = `clc-${volumeBasename}-${volumeSuffix}-node-modules`;

// Claude Code stores sessions under CLAUDE_CONFIG_DIR/projects/<path-encoded-dir>/
// We set CLAUDE_CONFIG_DIR to the workspace's .claude dir so sessions persist on the host
const claudeConfigDir = `${workspaceTarget}/.claude`;

function log(message) {
  console.log(`[clc-proxy] ${message}`);
}

async function startProxy() {
  const server = new ProxyChain.Server({ host, port, verbose });
  server.on('requestFailed', ({ request, error }) => {
    console.error(`[clc-proxy] request failed ${request?.url || ''}: ${error?.message || error}`);
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
        console.error(`[clc-proxy] request failed ${request?.url || ''}: ${reqErr?.message || reqErr}`);
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
  const normalizedWorkdir = path.resolve(workdirPath);

  log(`checking for running container with mount source "${normalizedWorkdir}"`);

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
      containers = [containers];
    }
  } catch {
    log('failed to parse container list output, will start a new container');
    return null;
  }

  for (const container of containers) {
    const containerId = container.configuration?.id;
    if (!containerId) continue;

    const inspectResult = spawnSync('container', ['inspect', containerId], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf-8',
    });

    if (inspectResult.status !== 0) continue;

    let detail;
    try {
      detail = JSON.parse(inspectResult.stdout);
      const items = Array.isArray(detail) ? detail : [detail];
      for (const item of items) {
        if (!item.configuration) continue;
        // Only reuse containers built from agentic-coding-node:24 image
        const imageName = item.configuration.image || '';
        if (!imageName.includes('agentic-coding')) {
          log(`container "${containerId}" uses old image, will not reuse`);
          continue;
        }
        for (const mount of item.configuration.mounts || []) {
          if (mount.type === 'virtiofs' || mount.type?.virtiofs !== undefined) {
            const mountSource = path.resolve(mount.source);
            if (mountSource === normalizedWorkdir) {
              log(`found running container "${containerId}" with ${workspaceTarget} mounted`);
              return containerId;
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function main() {
  if (!home) throw new Error('HOME is not set');

  // Copy .claude.json into a temp directory (Apple Container can't bind-mount files)
  const claudeJsonSrc = path.join(home, '.claude.json');
  const claudeJsonDir = path.join(workdir, '.claude', 'host-config');
  if (fs.existsSync(claudeJsonSrc)) {
    fs.mkdirSync(claudeJsonDir, { recursive: true });
    fs.copyFileSync(claudeJsonSrc, path.join(claudeJsonDir, 'claude.json'));
    log(`copied .claude.json to ${claudeJsonDir}/claude.json`);
  } else {
    log(`warning: ${claudeJsonSrc} not found, config will be missing inside container`);
  }

  // Check if a container is already running with our workdir mounted
  const existingContainerId = findContainerWithMount(workdir);

  if (existingContainerId) {
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

  // Build the claude args (same for both run and exec)
  const claudeArgs = [
    '--permission-mode', 'bypassPermissions',
    ...extraClaudeArgs,
  ];

  if (existingContainerId) {
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
      '-e', `CLAUDE_CONFIG_DIR=${claudeConfigDir}`,
      '-e', 'IS_SANDBOX=1',
      existingContainerId,
      'claude',
      ...claudeArgs,
    ];

    log(`exec: container ${args.slice(1, -claudeArgs.length - 1).join(' ')} ... claude --permission-mode bypassPermissions ...`);
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
      'run', ...(process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : []), '--memory', '4g',
      '--volume', `${workdir}:${workspaceTarget}`,
      '--mount', `type=volume,source=${nodeModulesVolume},target=${workspaceTarget}/node_modules`,
      ...extraVolumes.flatMap(v => ['--volume', v]),
      ...extraPublish.flatMap(p => ['--publish', p]),
      '--mount', `type=bind,source=${path.join(home, '.claude')},target=/host-claude`,
      '--mount', `type=bind,source=${claudeJsonDir},target=/host-claude-config`,
      '--dns', '1.1.1.1',
      '-e', `HTTP_PROXY=${proxyUrl}`,
      '-e', `HTTPS_PROXY=${proxyUrl}`,
      '-e', `ALL_PROXY=${proxyUrl}`,
      '-e', `http_proxy=${proxyUrl}`,
      '-e', `https_proxy=${proxyUrl}`,
      '-e', `all_proxy=${proxyUrl}`,
      '-e', `CLAUDE_CONFIG_DIR=${claudeConfigDir}`,
      '-e', 'IS_SANDBOX=1',
      '-w', workspaceTarget,
      'agentic-coding-node:24',
      'claude',
      ...claudeArgs,
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
  console.error(`[clc-proxy] ${error.stack || error.message || error}`);
  process.exit(1);
});

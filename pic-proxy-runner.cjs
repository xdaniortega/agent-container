#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ProxyChain = require('proxy-chain');

const host = process.env.PIC_PROXY_HOST || '192.168.64.1';
const port = Number(process.env.PIC_PROXY_PORT || 8888);
const proxyUrl = `http://${host}:${port}`;
const verbose = process.env.PIC_PROXY_VERBOSE === '1';
const workdir = process.env.PIC_WORKDIR || process.cwd();
const home = process.env.HOME;
const cliArgs = process.argv.slice(2);

// Extract --volume arguments from CLI args, the rest pass through to pi
const extraVolumes = [];
const extraPiArgs = [];
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--volume' && i + 1 < cliArgs.length) {
    extraVolumes.push(cliArgs[i + 1]);
    i++; // skip the value
  } else if (cliArgs[i].startsWith('--volume=')) {
    extraVolumes.push(cliArgs[i].slice(9));
  } else {
    extraPiArgs.push(cliArgs[i]);
  }
}

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;

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
    throw error;
  }
}

async function main() {
  if (!home) throw new Error('HOME is not set');

  fs.mkdirSync(path.join(workdir, 'sessions'), { recursive: true });

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

  const args = [
    'run', ...(process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : []), '--memory', '4g',
    '--volume', `${workdir}:${workspaceTarget}`,
    ...extraVolumes.flatMap(v => ['--volume', v]),
    '--mount', `type=bind,source=${path.join(home, '.pi')},target=/host-pi,readonly`,
    '--dns', '1.1.1.1',
    '-e', `HTTP_PROXY=${proxyUrl}`,
    '-e', `HTTPS_PROXY=${proxyUrl}`,
    '-e', `ALL_PROXY=${proxyUrl}`,
    '-e', `http_proxy=${proxyUrl}`,
    '-e', `https_proxy=${proxyUrl}`,
    '-e', `all_proxy=${proxyUrl}`,
    '-w', workspaceTarget,
    'pi-coding-node:24',
    '--session-dir', `${workspaceTarget}/sessions`,
    ...extraPiArgs,
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

main().catch((error) => {
  console.error(`[pic-proxy] ${error.stack || error.message || error}`);
  process.exit(1);
});

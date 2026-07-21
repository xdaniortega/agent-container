#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listContainersJson: listContainersJsonWithRecovery } = require('./container-system.cjs');
const {
  parseContainerRunnerArgs,
  proxyEnvironmentArgs,
  runChildProcess,
  startProxy: startProxyWithFallback,
} = require('./runner-utils.cjs');

const host = process.env.CLC_PROXY_HOST || '192.168.64.1';
const port = Number(process.env.CLC_PROXY_PORT || 8888);
const proxyUrl = `http://${host}:${port}`;
const verbose = process.env.CLC_PROXY_VERBOSE === '1';
const workdir = process.env.CLC_WORKDIR || process.cwd();
const home = process.env.HOME;
const cliArgs = process.argv.slice(2);

// Extract --volume, --publish/-p arguments from CLI args; pass the rest through to claude.
const { extraVolumes, extraPublish, passthroughArgs: extraClaudeArgs } = parseContainerRunnerArgs(cliArgs);

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;
const volumeSuffix = crypto.createHash('sha1').update(workdir).digest('hex').slice(0, 12);
const volumeBasename = dirBasename.replace(/[^a-zA-Z0-9_.-]/g, '-');
const nodeModulesVolume = `clc-${volumeBasename}-${volumeSuffix}-node-modules`;

// Keep Linux-native Claude Code auth/config in a host directory shared through VirtioFS.
// A named Apple Container volume cannot be attached read-write to multiple container VMs.
const claudeConfigDir = '/claude-config';
const claudeConfigHostDir = path.join(home || process.env.USERPROFILE || '.', '.clc-container', 'claude-config');
const claudeProjectsDir = `${claudeConfigDir}/projects`;
const claudeProjectsHostDir = path.join(home || process.env.USERPROFILE || '.', '.clc-container', 'claude-projects', `${volumeBasename}-${volumeSuffix}`);
const localClaudeDir = path.join(workdir, '.claude');
const localClaudeProjectsLink = path.join(localClaudeDir, 'projects');

function log(message) {
  console.log(`[clc-proxy] ${message}`);
}

async function startProxy() {
  return startProxyWithFallback({ host, port, proxyUrl, verbose, log, logPrefix: 'clc-proxy' });
}

function listContainersJson() {
  return listContainersJsonWithRecovery({ log });
}

// Check if a running container already has workdir mounted as a virtiofs share
function findContainerWithMount(workdirPath) {
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
        const image = item.configuration.image;
        const imageName = typeof image === 'string'
          ? image
          : image?.reference || image?.descriptor?.annotations?.['com.apple.containerization.image.name'] || '';
        if (!imageName.includes('agentic-coding')) {
          log(`container "${containerId}" uses image "${imageName || 'unknown'}", will not reuse`);
          continue;
        }

        let hasWorkdirMount = false;
        let hasClaudeConfigMount = false;
        let hasClaudeProjectsMount = false;
        for (const mount of item.configuration.mounts || []) {
          if (mount.type === 'virtiofs' || mount.type?.virtiofs !== undefined) {
            const mountSource = path.resolve(mount.source);
            if (mountSource === normalizedWorkdir) {
              hasWorkdirMount = true;
            }
          }
          const mountTarget = mount.target || mount.destination || mount.mountpoint || mount.mountPoint;
          const mountSourcePath = mount.source ? path.resolve(mount.source) : '';
          if (mountTarget === claudeConfigDir && mountSourcePath === path.resolve(claudeConfigHostDir)) {
            hasClaudeConfigMount = true;
          }
          if (mountTarget === claudeProjectsDir && mountSourcePath === path.resolve(claudeProjectsHostDir)) {
            hasClaudeProjectsMount = true;
          }
          }
        if (hasWorkdirMount && hasClaudeConfigMount && hasClaudeProjectsMount) {
          log(`found running container "${containerId}" with ${workspaceTarget} mounted`);
          return containerId;
        }

        if (hasWorkdirMount) {
          log(`container "${containerId}" has workdir mounted but is missing current Claude config/session mounts; will start a new container`);
        }
      }
    } catch (error) {
      log(`failed to inspect container "${containerId}": ${error?.message || error}`);
      continue;
    }
  }

  return null;
}

function ensureLocalProjectsLink() {
  fs.mkdirSync(localClaudeDir, { recursive: true });

  if (!fs.existsSync(localClaudeProjectsLink)) {
    fs.symlinkSync(claudeProjectsHostDir, localClaudeProjectsLink, 'dir');
    log(`linked ${path.relative(workdir, localClaudeProjectsLink)} -> ${claudeProjectsHostDir}`);
    return;
  }

  const stat = fs.lstatSync(localClaudeProjectsLink);
  if (stat.isSymbolicLink()) {
    const currentTarget = fs.readlinkSync(localClaudeProjectsLink);
    const resolvedTarget = path.resolve(localClaudeDir, currentTarget);
    if (resolvedTarget !== claudeProjectsHostDir) {
      fs.unlinkSync(localClaudeProjectsLink);
      fs.symlinkSync(claudeProjectsHostDir, localClaudeProjectsLink, 'dir');
      log(`updated ${path.relative(workdir, localClaudeProjectsLink)} -> ${claudeProjectsHostDir}`);
    }
    return;
  }

  log(`warning: ${localClaudeProjectsLink} already exists and is not a symlink; leaving it unchanged`);
}

async function main() {
  if (!home) throw new Error('HOME is not set');

  fs.mkdirSync(claudeConfigHostDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeProjectsHostDir, { recursive: true });
  ensureLocalProjectsLink();


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
      ...proxyEnvironmentArgs(proxyUrl),
      '-e', `CLAUDE_CONFIG_DIR=${claudeConfigDir}`,
      '-e', 'IS_SANDBOX=1',
      existingContainerId,
      '/usr/local/bin/entrypoint',
      'claude',
      ...claudeArgs,
    ];

    log(`exec: container ${args.slice(1, -claudeArgs.length - 1).join(' ')} ... claude --permission-mode bypassPermissions ...`);
    runChildProcess('container', args, { cleanup });
  } else {
    const args = [
      'run', '--rm', ...(process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : []), '--memory', '4g',
      '--volume', `${workdir}:${workspaceTarget}`,
      '--mount', `type=volume,source=${nodeModulesVolume},target=${workspaceTarget}/node_modules`,
      ...extraVolumes.flatMap(v => ['--volume', v]),
      ...extraPublish.flatMap(p => ['--publish', p]),
      '--mount', `type=bind,source=${path.join(home, '.claude')},target=/host-claude,readonly`,
      '--mount', `type=bind,source=${claudeConfigHostDir},target=${claudeConfigDir}`,
      '--mount', `type=bind,source=${claudeProjectsHostDir},target=${claudeProjectsDir}`,
      '--dns', '1.1.1.1',
      ...proxyEnvironmentArgs(proxyUrl),
      '-e', `CLAUDE_CONFIG_DIR=${claudeConfigDir}`,
      '-e', 'IS_SANDBOX=1',
      '-w', workspaceTarget,
      'agentic-coding-node:24',
      'claude',
      ...claudeArgs,
    ];

    runChildProcess('container', args, { cleanup });
  }
}

main().catch((error) => {
  console.error(`[clc-proxy] ${error.stack || error.message || error}`);
  process.exit(1);
});

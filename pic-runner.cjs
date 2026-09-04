#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listContainersJson: listContainersJsonWithRecovery } = require('./container-system.cjs');
const {
  buildPicMountArgs,
  getProjectSessionsNamespace,
  parseContainerRunnerArgs,
  proxyEnvironmentArgs: buildProxyEnvironmentArgs,
  runChildProcess,
  stageHostPiConfig,
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

// Extract runner-level --proxy, --anthropic/-a, --volume, and --publish/-p
// arguments; pass the rest to Pi.
const parsedArgs = parseContainerRunnerArgs(cliArgs, { booleanFlags: ['--proxy', '--anthropic', '-a'] });
if (parsedArgs.flags['--proxy']) proxyEnabled = true;
const anthropicEnabled = parsedArgs.flags['--anthropic'] || parsedArgs.flags['-a'];
const { extraVolumes, extraPublish } = parsedArgs;
const attachMode = parsedArgs.passthroughArgs[0] === 'attach';
const extraPiArgs = attachMode ? parsedArgs.passthroughArgs.slice(1) : parsedArgs.passthroughArgs;

// Use the basename of the current directory so multiple mounts can coexist under /workspace
const dirBasename = path.basename(workdir);
const workspaceTarget = `/workspace/${dirBasename}`;
const volumeSuffix = crypto.createHash('sha1').update(workdir).digest('hex').slice(0, 12);
const volumeBasename = dirBasename.replace(/[^a-zA-Z0-9_.-]/g, '-');
const nodeModulesVolume = `pic-${volumeBasename}-${volumeSuffix}-node-modules`;

// Session directory — persist in host project-scoped namespace (~/.pi/agent/sessions/<namespace>)
// so host-side tools like agentsview can read session transcripts directly.
// Pi writes UUID-named session files, so concurrent processes within the project will not collide.
const projectSessionsNamespace = getProjectSessionsNamespace(workdir);
const hostSessionsDir = path.join(home || process.env.USERPROFILE || '.', '.pi', 'agent', 'sessions', projectSessionsNamespace);
const containerSessionsDir = '/pi-sessions';
const sessionDir = containerSessionsDir;
const stagedPiHostDir = path.join(home || process.env.USERPROFILE || '.', '.pic-container', 'pi-config', `${volumeBasename}-${volumeSuffix}`);
const hostNpmDir = path.join(home || process.env.USERPROFILE || '.', '.pi', 'agent', 'npm');
const hostGitDir = path.join(home || process.env.USERPROFILE || '.', '.pi', 'agent', 'git');
const stagedHostSkillsDir = path.join(workdir, '.pi', 'host-agent-skills');
const stagedHostExtensionsDir = path.join(workdir, '.pi', 'host-agent-extensions');
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

// Anthropic env keys to forward into the container. The container does not
// inherit the host env, so without this the key never reaches Pi inside.
const anthropicEnvironmentNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'];

// Generic, opt-in way to source a key without storing it anywhere: when
// --anthropic is passed but no ANTHROPIC_* key is in the environment, run the
// command given by PI_ANTHROPIC_KEY_CMD (e.g. an `op read` 1Password lookup)
// on the host and use its stdout as ANTHROPIC_API_KEY. The repo never contains
// the secret or the command itself — only this indirection.
function runAnthropicKeyCommand(cmd) {
  try {
    const result = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (result.status === 0) {
      const key = (result.stdout || '').trim();
      return key || '';
    }
    const err = (result.stderr || '').trim();
    log(`warning: PI_ANTHROPIC_KEY_CMD exited with status ${result.status}${err ? `: ${err}` : ''}`);
  } catch (err) {
    log(`warning: PI_ANTHROPIC_KEY_CMD failed: ${err.message}`);
  }
  return '';
}

function anthropicEnvironmentArgs({ useAnthropic } = {}) {
  if (!useAnthropic) return [];
  const args = [];
  let any = false;
  for (const name of anthropicEnvironmentNames) {
    const value = process.env[name];
    if (value) {
      args.push('-e', `${name}=${value}`);
      any = true;
    }
  }
  if (!any) {
    const cmd = process.env.PI_ANTHROPIC_KEY_CMD;
    if (cmd) {
      const key = runAnthropicKeyCommand(cmd);
      if (key) {
        args.push('-e', `ANTHROPIC_API_KEY=${key}`);
        any = true;
      } else {
        log('warning: --anthropic requested but PI_ANTHROPIC_KEY_CMD produced no key; using local auth');
      }
    } else {
      log('warning: --anthropic requested but no ANTHROPIC_* key in env and PI_ANTHROPIC_KEY_CMD unset; using local auth');
    }
  }
  // When an Anthropic key is in play, ignore the host's stored auth.json:
  // Pi resolves stored credentials before env keys, so a copied auth.json would
  // shadow ANTHROPIC_API_KEY. entrypoint.sh honors PIC_EXCLUDE_AUTH=1 to skip it.
  if (any) args.push('-e', 'PIC_EXCLUDE_AUTH=1');
  return args;
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

function stageHostSkills() {
  const sourceDir = path.join(home, '.pi', 'agent', 'skills');
  fs.rmSync(stagedHostSkillsDir, { recursive: true, force: true });
  fs.mkdirSync(stagedHostSkillsDir, { recursive: true });

  if (!fs.existsSync(sourceDir)) return;

  for (const name of fs.readdirSync(sourceDir)) {
    const source = path.join(sourceDir, name);
    const skillFile = path.join(source, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) log(`warning: skipping host skill "${name}" because its symlink target is unavailable`);
      continue;
    }

    try {
      fs.cpSync(source, path.join(stagedHostSkillsDir, name), {
        recursive: true,
        dereference: true,
        force: true,
      });
    } catch (error) {
      log(`warning: failed to stage host skill "${name}": ${error.message}`);
    }
  }
}

function stageHostExtensions() {
  const sourceDir = path.join(home, '.pi', 'agent', 'extensions');
  fs.rmSync(stagedHostExtensionsDir, { recursive: true, force: true });
  fs.mkdirSync(stagedHostExtensionsDir, { recursive: true });
  if (!fs.existsSync(sourceDir)) return;
  for (const name of fs.readdirSync(sourceDir)) {
    const source = path.join(sourceDir, name);
    try {
      fs.cpSync(source, path.join(stagedHostExtensionsDir, name), { recursive: true, dereference: true, force: true });
    } catch (error) {
      log(`warning: failed to stage host extension "${name}": ${error.message}`);
    }
  }
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
  const mountArgs = buildPicMountArgs({
    workdir,
    workspaceTarget,
    nodeModulesVolume,
    stagedPiHostDir,
    hostSessionsDir,
    containerSessionsDir,
    extraVolumes,
    includeHerdrSocket,
    herdrSocketVolumeArgs: herdrSocketVolumeArgs(),
    extraPublish,
    hostNpmDir,
    hostGitDir,
  });

  return [
    'run', '--rm', ...interactiveContainerArgs(), '--memory', '4g',
    ...mountArgs,
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

function refreshContainerExtensions(containerId) {
  const stagedCrew = path.join(stagedHostExtensionsDir, 'crew', 'index.ts');
  if (!fs.existsSync(stagedCrew)) return true;
  const command = `mkdir -p /root/.pi/agent/extensions && rm -rf /root/.pi/agent/extensions/crew && cp -aL ${workspaceTarget}/.pi/host-agent-extensions/crew /root/.pi/agent/extensions/crew && test -f /root/.pi/agent/extensions/crew/index.ts`;
  const result = spawnSync('container', ['exec', containerId, 'sh', '-lc', command], { stdio: verbose ? 'inherit' : 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    log(`container "${containerId}" has no usable staged Crew extension; it will not be reused`);
    return false;
  }
  log(`verified Crew extension in reused container "${containerId}"`);
  return true;
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
        let hasSessionsMount = false;
        let hasNodeModulesMount = false;
        let hasHerdrSocketMount = !herdrSocketDir;
        let hasNpmMount = !fs.existsSync(hostNpmDir);
        let hasGitMount = !fs.existsSync(hostGitDir);
        for (const mount of item.configuration.mounts || []) {
          const mountTarget = mount.target || mount.destination || mount.mountpoint || mount.mountPoint;
          const mountSourcePath = mount.source ? path.resolve(mount.source) : '';
          const mountSourceName = String(mount.type?.volume?.name || mount.name || mount.source || '');
          if (mount.type === 'virtiofs' || mount.type?.virtiofs !== undefined) {
            if (mountSourcePath === normalizedWorkdir && mountTarget === workspaceTarget) {
              hasWorkdirMount = true;
            }
          }
          if (mountTarget === '/host-pi' && mountSourcePath === path.resolve(stagedPiHostDir)) {
            hasPiConfigMount = true;
          }
          if (mountTarget === containerSessionsDir && mountSourcePath === path.resolve(hostSessionsDir)) {
            hasSessionsMount = true;
          }
          if (mountTarget === '/host-pi-npm' && mountSourcePath === path.resolve(hostNpmDir)) {
            hasNpmMount = true;
          }
          if (mountTarget === '/host-pi-git' && mountSourcePath === path.resolve(hostGitDir)) {
            hasGitMount = true;
          }
          if (herdrSocketDir && mountSourcePath === path.resolve(herdrSocketDir) && mountTarget === herdrSocketMountTarget) {
            hasHerdrSocketMount = true;
          }
          if (mountTarget === `${workspaceTarget}/node_modules` && mountSourceName.includes(nodeModulesVolume)) {
            hasNodeModulesMount = true;
          }
        }
        if (hasWorkdirMount && hasPiConfigMount && hasSessionsMount && hasNodeModulesMount && hasHerdrSocketMount && hasNpmMount && hasGitMount) {
          if (!refreshContainerExtensions(containerId)) {
            spawnSync('container', ['stop', containerId], { stdio: verbose ? 'inherit' : 'ignore' });
            continue;
          }
          log(`found compatible running container "${containerId}" with ${workspaceTarget} mounted`);
          return containerId;
        }
        if (hasWorkdirMount) {
          log(`container "${containerId}" has the workdir mounted but is missing current Pi config/sessions/node_modules/Herdr socket mounts; will not reuse`);
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

  stageHostPiConfig({ homeDir: home, targetDir: stagedPiHostDir, log });
  fs.mkdirSync(hostSessionsDir, { recursive: true });
  stageHostSkills();
  stageHostExtensions();

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

  const sessionEnvArgs = ['-e', `PI_CODING_AGENT_SESSION_DIR=${containerSessionsDir}`];

  if (attachMode) {
    const shellArgs = extraPiArgs.length > 0 ? extraPiArgs : ['/bin/bash'];
    const envArgs = [
      ...proxyEnvironmentArgs(),
      ...anthropicEnvironmentArgs({ useAnthropic: anthropicEnabled }),
      ...sessionEnvArgs,
    ];

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
        ...anthropicEnvironmentArgs({ useAnthropic: anthropicEnabled }),
        ...sessionEnvArgs,
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
        ...anthropicEnvironmentArgs({ useAnthropic: anthropicEnabled }),
        ...sessionEnvArgs,
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

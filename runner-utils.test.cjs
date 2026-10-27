/**
 * @notice Verifies pic runner helpers: mounts, config staging, gateway and image-digest parsing, and atomic installs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildPicMountArgs,
  createStagedPiConfigInstanceDir,
  detectContainerGateway,
  getProjectSessionsNamespace,
  INSTALL_PATH_ATOMIC_SH,
  buildExtensionRefreshScript,
  isStagedPiConfigInstanceName,
  parseContainerImageDigest,
  parseContainerNetworkGateway,
  parseImageInspectDigest,
  pruneStagedPiConfigDirs,
  redactSensitiveArgs,
  replaceDirAtomically,
  stageHostPiConfig,
} = require('./runner-utils.cjs');

function makeFakePiHome(root) {
  const fakeHome = path.join(root, 'home');
  const fakePi = path.join(fakeHome, '.pi');
  fs.mkdirSync(path.join(fakePi, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(fakePi, 'agent', 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(fakePi, 'agent', 'auth.json'), '{"key":"secret"}');
  fs.writeFileSync(path.join(fakePi, 'agent', 'models-store.json'), '{"models":[]}');
  return fakeHome;
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    process.exitCode = 1;
    throw error;
  }
}

// 1. Namespace transform matches Pi's safePath encoding
test('namespace transform matches Pi safePath encoding for host project path', () => {
  const ns = getProjectSessionsNamespace('/Users/daniel/repos/agent-container');
  assert.equal(ns, '--Users-daniel-repos-agent-container--');
});

// 2. Generated mount list contains project-scoped sessions mount targeting /pi-sessions
test('generated mount list contains project-scoped sessions mount targeting /pi-sessions', () => {
  const home = '/fake/home';
  const workdir = '/Users/daniel/repos/agent-container';
  const ns = getProjectSessionsNamespace(workdir);
  const hostSessionsDir = path.join(home, '.pi', 'agent', 'sessions', ns);
  const stagedPiHostDir = path.join(home, '.pic-container', 'pi-config', 'proj-123');

  const mountArgs = buildPicMountArgs({
    workdir,
    workspaceTarget: '/workspace/agent-container',
    nodeModulesVolume: 'vol-node-modules',
    stagedPiHostDir,
    hostSessionsDir,
    containerSessionsDir: '/pi-sessions',
  });

  const sessionsMountIndex = mountArgs.findIndex((arg, i) =>
    arg === '--mount' &&
    mountArgs[i + 1]?.includes(`source=${hostSessionsDir}`) &&
    mountArgs[i + 1]?.includes('target=/pi-sessions')
  );
  assert.ok(sessionsMountIndex >= 0, 'sessions mount targeting /pi-sessions must be present');
});

// 3. Mount invariant: NO generated mount has source equal to ~/.pi, ~/.pi/agent/sessions, or any ancestor of hostSessionsDir
test('mount invariant: no wide mounts of ~/.pi or sessions parent directory', () => {
  const home = '/fake/home';
  const workdir = '/Users/daniel/repos/agent-container';
  const ns = getProjectSessionsNamespace(workdir);
  const hostSessionsDir = path.join(home, '.pi', 'agent', 'sessions', ns);
  const stagedPiHostDir = path.join(home, '.pic-container', 'pi-config', 'proj-123');

  const mountArgs = buildPicMountArgs({
    workdir,
    workspaceTarget: '/workspace/agent-container',
    nodeModulesVolume: 'vol-node-modules',
    stagedPiHostDir,
    hostSessionsDir,
    containerSessionsDir: '/pi-sessions',
  });

  const forbiddenSources = [
    path.resolve(home, '.pi'),
    path.resolve(home, '.pi', 'agent'),
    path.resolve(home, '.pi', 'agent', 'sessions'),
    path.resolve(home),
  ];

  for (let i = 0; i < mountArgs.length; i += 1) {
    const arg = mountArgs[i];
    if (arg === '--mount') {
      const spec = mountArgs[i + 1] || '';
      const sourceMatch = spec.match(/source=([^,]+)/);
      if (sourceMatch) {
        const sourcePath = path.resolve(sourceMatch[1]);
        for (const forbidden of forbiddenSources) {
          assert.notEqual(sourcePath, forbidden, `Mount source must not be wide parent ${forbidden}: ${spec}`);
        }
      }
    } else if (arg === '--volume' || arg === '-v') {
      const spec = mountArgs[i + 1] || '';
      const [source] = spec.split(':');
      if (source) {
        const sourcePath = path.resolve(source);
        for (const forbidden of forbiddenSources) {
          assert.notEqual(sourcePath, forbidden, `Volume source must not be wide parent ${forbidden}: ${spec}`);
        }
      }
    }
  }
});

// 4. Staging regression guard: staged tree contains no sessions path at any depth
test('staging regression guard: staged tree contains no sessions path at any depth', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-staging-'));
  try {
    const fakeHome = path.join(tmpRoot, 'home');
    const fakePi = path.join(fakeHome, '.pi');
    const fakeTarget = path.join(tmpRoot, 'staged-pi');

    // Populate a realistic ~/.pi with config, auth, and sessions
    fs.mkdirSync(path.join(fakePi, 'agent', 'sessions', '--proj-a--'), { recursive: true });
    fs.mkdirSync(path.join(fakePi, 'agent', 'sessions', '--proj-b--'), { recursive: true });
    fs.mkdirSync(path.join(fakePi, 'agent', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(fakePi, 'agent', 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(fakePi, 'agent', 'sessions', '--proj-a--', 's1.jsonl'), '{"type":"session"}');
    fs.writeFileSync(path.join(fakePi, 'agent', 'sessions', '--proj-b--', 's2.jsonl'), '{"type":"session"}');
    fs.writeFileSync(path.join(fakePi, 'agent', 'settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(path.join(fakePi, 'agent', 'auth.json'), '{"key":"secret"}');
    fs.writeFileSync(path.join(fakePi, 'agent', 'models-store.json'), '{"models":[]}');

    const staged = stageHostPiConfig({ homeDir: fakeHome, targetDir: fakeTarget });
    assert.equal(staged, true);

    // Verify settings, auth, and models-store were copied
    assert.ok(fs.existsSync(path.join(fakeTarget, 'agent', 'settings.json')));
    assert.ok(fs.existsSync(path.join(fakeTarget, 'agent', 'auth.json')));
    assert.ok(fs.existsSync(path.join(fakeTarget, 'agent', 'models-store.json')));

    // Walk entire staged tree and assert NO file or folder is named 'sessions' or inside 'sessions'
    function assertNoSessions(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        assert.notEqual(entry.name, 'sessions', `Found forbidden 'sessions' entry at ${path.join(dir, entry.name)}`);
        assert.notEqual(entry.name, 'bin', `Found forbidden 'bin' entry at ${path.join(dir, entry.name)}`);
        if (entry.isDirectory()) {
          assertNoSessions(path.join(dir, entry.name));
        }
      }
    }
    assertNoSessions(fakeTarget);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 5. Concurrency regression: a second launch must not touch the first launch's staged dir
test('concurrent launches stage into isolated dirs and never clobber a live mount', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-concurrent-'));
  try {
    const fakeHome = makeFakePiHome(tmpRoot);
    const stagingRoot = path.join(tmpRoot, 'pi-config', 'proj-abc123');

    // Session 1 stages and "mounts" its instance dir.
    const first = createStagedPiConfigInstanceDir(stagingRoot);
    assert.equal(stageHostPiConfig({ homeDir: fakeHome, targetDir: first }), true);

    // Session 2 stages while session 1 is still running.
    const second = createStagedPiConfigInstanceDir(stagingRoot);
    assert.notEqual(first, second, 'each launch must get its own staged directory');
    assert.equal(stageHostPiConfig({ homeDir: fakeHome, targetDir: second }), true);

    // Session 1's config must still be fully intact — this is the exact regression
    // where the second session emptied /host-pi and wiped model/api configuration.
    for (const file of ['settings.json', 'auth.json', 'models-store.json']) {
      assert.ok(
        fs.existsSync(path.join(first, 'agent', file)),
        `session 1 lost ${file} when session 2 staged config`,
      );
      assert.ok(fs.existsSync(path.join(second, 'agent', file)), `session 2 missing ${file}`);
    }
    assert.equal(fs.readFileSync(path.join(first, 'agent', 'auth.json'), 'utf8'), '{"key":"secret"}');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 6. GC keeps mounted/recent instances and reclaims stale ones
test('staged config GC preserves in-use and recent dirs, removes stale ones', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-gc-'));
  try {
    const fakeHome = makeFakePiHome(tmpRoot);
    const stagingRoot = path.join(tmpRoot, 'pi-config', 'proj-abc123');

    const mounted = createStagedPiConfigInstanceDir(stagingRoot);
    stageHostPiConfig({ homeDir: fakeHome, targetDir: mounted });
    const stale = path.join(stagingRoot, `${Date.now() - 999}-4242-aaaaaa`);
    stageHostPiConfig({ homeDir: fakeHome, targetDir: stale });
    const recent = createStagedPiConfigInstanceDir(stagingRoot);
    stageHostPiConfig({ homeDir: fakeHome, targetDir: recent });

    // Age `mounted` and `stale` well past the retention window; `mounted` is still
    // bind-mounted by a live container so it must survive anyway.
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(mounted, old, old);
    fs.utimesSync(stale, old, old);

    const removed = pruneStagedPiConfigDirs({
      rootDir: stagingRoot,
      keepDirs: [mounted],
      minAgeMs: 60 * 60 * 1000,
    });

    assert.ok(fs.existsSync(mounted), 'must not remove a directory mounted by a live container');
    assert.ok(fs.existsSync(recent), 'must not remove a freshly staged directory');
    assert.ok(!fs.existsSync(stale), 'stale unused directory should be reclaimed');
    assert.deepEqual(removed, [stale]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 7. Instance-name recognition (drives GC eligibility and container-reuse matching)
test('staged config instance names are recognized, unrelated names are not', () => {
  const instance = path.basename(createStagedPiConfigInstanceDir('/tmp/root'));
  assert.ok(isStagedPiConfigInstanceName(instance));
  for (const name of ['agent', 'proj-abc123', '', 'settings.json', '123-abc']) {
    assert.ok(!isStagedPiConfigInstanceName(name), `${name} must not look like an instance dir`);
  }
});

// 8. A failed swap must never leave an existing staged config empty
test('failed staging preserves the previous staged config', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-failstage-'));
  try {
    const fakeHome = makeFakePiHome(tmpRoot);
    const target = path.join(tmpRoot, 'pi-config', 'proj', 'staged');
    assert.equal(stageHostPiConfig({ homeDir: fakeHome, targetDir: target }), true);

    // Fail the swap-in of the freshly copied tree (the busy-mount EBUSY/ENOTEMPTY
    // case). The old implementation deleted the target *before* this rename, so a
    // failure here left /host-pi empty and wiped model/api config.
    const realRenameSync = fs.renameSync;
    fs.renameSync = (src, dest) => {
      if (String(src).includes('.tmp.')) throw new Error('simulated swap failure');
      return realRenameSync(src, dest);
    };
    let result;
    try {
      result = stageHostPiConfig({ homeDir: fakeHome, targetDir: target, log: () => {} });
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.equal(result, true, 'should report the surviving previous staging');
    assert.ok(
      fs.existsSync(path.join(target, 'agent', 'auth.json')),
      'previous staged config must survive a failed re-stage',
    );
    assert.equal(fs.readFileSync(path.join(target, 'agent', 'settings.json'), 'utf8'), '{"theme":"dark"}');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 9. parseContainerNetworkGateway handles array, object, missing default, and invalid JSON
test('parseContainerNetworkGateway parses array of networks with default network', () => {
  const json = JSON.stringify([
    { id: 'eval-net', status: { ipv4Gateway: '192.168.64.1' } },
    { id: 'default', configuration: { name: 'default' }, status: { ipv4Gateway: '192.168.65.1' } },
  ]);
  assert.equal(parseContainerNetworkGateway(json), '192.168.65.1');
});

test('parseContainerNetworkGateway parses single object default network', () => {
  const json = JSON.stringify({
    id: 'default',
    configuration: { name: 'default' },
    status: { ipv4Gateway: '192.168.65.1' },
  });
  assert.equal(parseContainerNetworkGateway(json), '192.168.65.1');
});

test('parseContainerNetworkGateway returns null when default network is missing', () => {
  const json = JSON.stringify([
    { id: 'eval-1', configuration: { name: 'eval-1' }, status: { ipv4Gateway: '192.168.66.1' } },
    { id: 'eval-2', configuration: { name: 'eval-2' }, status: { ipv4Gateway: '192.168.67.1' } },
  ]);
  assert.equal(parseContainerNetworkGateway(json), null);
});

test('parseContainerNetworkGateway returns null for invalid JSON or non-string inputs', () => {
  assert.equal(parseContainerNetworkGateway('{invalid json'), null);
  assert.equal(parseContainerNetworkGateway(''), null);
  assert.equal(parseContainerNetworkGateway(null), null);
  assert.equal(parseContainerNetworkGateway(undefined), null);
  assert.equal(parseContainerNetworkGateway(123), null);
});

// 10. detectContainerGateway invokes container network list and parses gateway
test('detectContainerGateway delegates to spawnSyncImpl and returns gateway', () => {
  const mockSpawn = (cmd, args) => {
    assert.equal(cmd, 'container');
    assert.deepEqual(args, ['network', 'list', '--format', 'json']);
    return {
      status: 0,
      stdout: JSON.stringify([{ id: 'default', status: { ipv4Gateway: '192.168.65.1' } }]),
    };
  };
  assert.equal(detectContainerGateway({ spawnSyncImpl: mockSpawn }), '192.168.65.1');

  const failSpawn = () => ({ status: 1, stdout: '' });
  assert.equal(detectContainerGateway({ spawnSyncImpl: failSpawn }), null);
});

// 11. replaceDirAtomically creates, swaps, and preserves on failure
test('replaceDirAtomically creates directory and replaces it atomically', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-atomic-'));
  try {
    const targetDir = path.join(tmpRoot, 'staged-skills');

    // First creation
    replaceDirAtomically(targetDir, (temp) => {
      fs.writeFileSync(path.join(temp, 'file1.txt'), 'version 1');
    });
    assert.equal(fs.readFileSync(path.join(targetDir, 'file1.txt'), 'utf8'), 'version 1');

    // Atomic replacement
    replaceDirAtomically(targetDir, (temp) => {
      fs.writeFileSync(path.join(temp, 'file1.txt'), 'version 2');
      fs.writeFileSync(path.join(temp, 'file2.txt'), 'new file');
    });
    assert.equal(fs.readFileSync(path.join(targetDir, 'file1.txt'), 'utf8'), 'version 2');
    assert.equal(fs.readFileSync(path.join(targetDir, 'file2.txt'), 'utf8'), 'new file');

    // Failed replacement: exception thrown during build preserves original directory
    assert.throws(() => {
      replaceDirAtomically(targetDir, (temp) => {
        fs.writeFileSync(path.join(temp, 'file1.txt'), 'broken');
        throw new Error('disk full or build error');
      });
    }, /disk full or build error/);

    assert.equal(fs.readFileSync(path.join(targetDir, 'file1.txt'), 'utf8'), 'version 2');
    assert.equal(fs.readFileSync(path.join(targetDir, 'file2.txt'), 'utf8'), 'new file');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 12. replaceDirAtomically lost-race handling and sibling cleanup
test('replaceDirAtomically handles lost race on target rename (ENOENT) gracefully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-atomic-enoent-'));
  try {
    const targetDir = path.join(tmpRoot, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'version.txt'), 'old');

    // Simulate sibling moving target aside right as exists check passed
    const realRenameSync = fs.renameSync;
    let hooked = false;
    fs.renameSync = (src, dest) => {
      if (String(src) === targetDir && String(dest).includes('.trash.') && !hooked) {
        hooked = true;
        // In reality, ENOENT happens because the sibling moved targetDir away
        fs.rmSync(targetDir, { recursive: true, force: true });
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return realRenameSync(src, dest);
    };

    try {
      replaceDirAtomically(targetDir, (temp) => {
        fs.writeFileSync(path.join(temp, 'version.txt'), 'new');
      });
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.ok(hooked, 'renameSync hook should have executed');
    assert.equal(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8'), 'new');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('replaceDirAtomically handles lost race on swap (ENOTEMPTY/EEXIST) without throwing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-atomic-enotempty-'));
  try {
    const targetDir = path.join(tmpRoot, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'version.txt'), 'installed-by-sibling');

    const realRenameSync = fs.renameSync;
    let hooked = false;
    fs.renameSync = (src, dest) => {
      if (String(src).includes('.tmp.') && String(dest) === targetDir) {
        hooked = true;
        const err = new Error('ENOTEMPTY: directory not empty');
        err.code = 'ENOTEMPTY';
        throw err;
      }
      return realRenameSync(src, dest);
    };

    try {
      // Should not throw, discards own temp, preserves existing target
      replaceDirAtomically(targetDir, (temp) => {
        fs.writeFileSync(path.join(temp, 'version.txt'), 'my-temp');
      });
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.ok(hooked, 'swap rename hook should have executed');
    assert.equal(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8'), 'installed-by-sibling');

    // Verify temp directory was cleaned up
    const remaining = fs.readdirSync(tmpRoot);
    assert.deepEqual(remaining, ['target']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('replaceDirAtomically cleans up stale sibling tmp and trash dirs older than 10 minutes', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pic-test-atomic-cleanup-'));
  try {
    const targetDir = path.join(tmpRoot, 'target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'version.txt'), 'v1');

    const staleTmp = path.join(tmpRoot, 'target.tmp.12345');
    const staleTrash = path.join(tmpRoot, 'target.trash.12345');
    const recentTmp = path.join(tmpRoot, 'target.tmp.99999');
    fs.mkdirSync(staleTmp, { recursive: true });
    fs.mkdirSync(staleTrash, { recursive: true });
    fs.mkdirSync(recentTmp, { recursive: true });

    const now = Date.now();
    const oldTime = new Date(now - 15 * 60 * 1000); // 15 mins old
    fs.utimesSync(staleTmp, oldTime, oldTime);
    fs.utimesSync(staleTrash, oldTime, oldTime);

    replaceDirAtomically(targetDir, (temp) => {
      fs.writeFileSync(path.join(temp, 'version.txt'), 'v2');
    }, { now });

    assert.ok(!fs.existsSync(staleTmp), 'stale .tmp sibling should be removed');
    assert.ok(!fs.existsSync(staleTrash), 'stale .trash sibling should be removed');
    assert.ok(fs.existsSync(recentTmp), 'recent .tmp sibling should be preserved');
    assert.equal(fs.readFileSync(path.join(targetDir, 'version.txt'), 'utf8'), 'v2');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 13. redactSensitiveArgs redacts key/token/secret/password arguments
test('redactSensitiveArgs redacts sensitive env variables while preserving safe ones', () => {
  const input = [
    'exec',
    '-w', '/workspace/proj',
    '-e', 'PIC_PROXY_MODE=0',
    '-e', 'ANTHROPIC_API_KEY=sk-ant-api03-secretkey',
    '-e', 'ANTHROPIC_AUTH_TOKEN=secret-token',
    '-e', 'GITHUB_TOKEN=ghp_secret',
    '-e', 'APP_SECRET=supersecret',
    '-e', 'DB_PASSWORD=mypassword',
    '--env=API_KEY=other-secret',
    '-eSAFE_VAR=visible',
    '-e', 'GIT_AUTHOR_NAME=Daniel Ortega',
    'container-123',
    'entrypoint',
    'pi',
  ];

  const redacted = redactSensitiveArgs(input);
  assert.deepEqual(redacted, [
    'exec',
    '-w', '/workspace/proj',
    '-e', 'PIC_PROXY_MODE=0',
    '-e', 'ANTHROPIC_API_KEY=[REDACTED]',
    '-e', 'ANTHROPIC_AUTH_TOKEN=[REDACTED]',
    '-e', 'GITHUB_TOKEN=[REDACTED]',
    '-e', 'APP_SECRET=[REDACTED]',
    '-e', 'DB_PASSWORD=[REDACTED]',
    '--env=API_KEY=[REDACTED]',
    '-eSAFE_VAR=visible',
    '-e', 'GIT_AUTHOR_NAME=Daniel Ortega',
    'container-123',
    'entrypoint',
    'pi',
  ]);
});

// --- Fix round 2: image digest parsing ---
test('parseImageInspectDigest reads configuration.descriptor.digest from live image inspect output', () => {
  const live = JSON.stringify([{
    configuration: { descriptor: { digest: 'sha256:ee30aa' }, name: 'agentic-coding-node:24' },
    id: 'ee30aa',
    variants: [{ platform: { os: 'linux' } }],
  }]);
  assert.equal(parseImageInspectDigest(live), 'sha256:ee30aa');
});

test('parseImageInspectDigest falls back to id (prefixing sha256:) then index.digest', () => {
  assert.equal(parseImageInspectDigest(JSON.stringify([{ id: 'abc123' }])), 'sha256:abc123');
  assert.equal(parseImageInspectDigest(JSON.stringify({ id: 'sha256:abc123' })), 'sha256:abc123');
  assert.equal(parseImageInspectDigest(JSON.stringify([{ index: { digest: 'sha256:idx' } }])), 'sha256:idx');
  // descriptor beats id beats index
  assert.equal(parseImageInspectDigest(JSON.stringify([{ configuration: { descriptor: { digest: 'sha256:d' } }, id: 'x', index: { digest: 'sha256:i' } }])), 'sha256:d');
  assert.equal(parseImageInspectDigest(JSON.stringify([{ id: 'x', index: { digest: 'sha256:i' } }])), 'sha256:x');
});

test('parseImageInspectDigest returns null for invalid, empty or digest-less input', () => {
  assert.equal(parseImageInspectDigest('not json'), null);
  assert.equal(parseImageInspectDigest(undefined), null);
  assert.equal(parseImageInspectDigest('[]'), null);
  assert.equal(parseImageInspectDigest('null'), null);
  assert.equal(parseImageInspectDigest(JSON.stringify([null, 'x', {}, { id: '  ' }])), null);
});

test('parseContainerImageDigest reads configuration.image.descriptor.digest and ignores the container id', () => {
  const item = { id: 'my-container', configuration: { id: 'my-container', image: { reference: 'agentic-coding-node:24', descriptor: { digest: 'sha256:ee30aa' } } } };
  assert.equal(parseContainerImageDigest(item), 'sha256:ee30aa');
  assert.equal(parseContainerImageDigest({ configuration: { image: { index: { digest: 'sha256:idx' } } } }), 'sha256:idx');
  assert.equal(parseContainerImageDigest({ id: 'my-container', configuration: { image: 'agentic-coding-node:24' } }), null);
  assert.equal(parseContainerImageDigest({ configuration: {} }), null);
  assert.equal(parseContainerImageDigest(null), null);
});

// --- Fix round 2: shared atomic-install shell function ---
test('entrypoint.sh install_path_atomic matches INSTALL_PATH_ATOMIC_SH (drift guard)', () => {
  const entry = fs.readFileSync(path.join(__dirname, 'entrypoint.sh'), 'utf8');
  const m = entry.match(/# BEGIN install_path_atomic[\s\S]*?# END install_path_atomic/);
  assert.ok(m, 'markers present in entrypoint.sh');
  const norm = (text) => text.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  assert.equal(norm(m[0]), norm(INSTALL_PATH_ATOMIC_SH));
});

test('install_path_atomic stages outside scanned dirs, uses lock with stale handling, and never nests', () => {
  assert.match(INSTALL_PATH_ATOMIC_SH, /PIC_STAGING_ROOT:-\/root\/\.pi\/\.staging/);
  assert.match(INSTALL_PATH_ATOMIC_SH, /mkdir "\$ia_lock"/);
  assert.match(INSTALL_PATH_ATOMIC_SH, /-mmin \+10/);
  assert.match(INSTALL_PATH_ATOMIC_SH, /mv -T "\$ia_tmp" "\$ia_dest"/);
  assert.ok(!/mv "\$ia_tmp"/.test(INSTALL_PATH_ATOMIC_SH), 'no non -T fallback that can nest tmp inside dest');
  assert.ok(!/\$ia_dest\.(tmp|trash|lock)/.test(INSTALL_PATH_ATOMIC_SH), 'no staging siblings next to dest');
});

test('buildExtensionRefreshScript never exits on a lost race and only checks index.ts at the end', () => {
  const script = buildExtensionRefreshScript({ src: '/workspace/p/.pi/host-agent-extensions/crew', dest: '/root/.pi/agent/extensions/crew' });
  assert.ok(!/exit 1/.test(script));
  assert.ok(!/set -e/.test(script));
  assert.match(script, /install_path_atomic '\/workspace\/p\/\.pi\/host-agent-extensions\/crew' '\/root\/\.pi\/agent\/extensions\/crew' \|\| true/);
  const lines = script.trim().split('\n');
  assert.equal(lines[lines.length - 1], "test -f '/root/.pi/agent/extensions/crew/index.ts'");
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildPicMountArgs,
  createStagedPiConfigInstanceDir,
  getProjectSessionsNamespace,
  isStagedPiConfigInstanceName,
  pruneStagedPiConfigDirs,
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildPicMountArgs,
  getProjectSessionsNamespace,
  stageHostPiConfig,
} = require('./runner-utils.cjs');

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

const { spawnSync } = require('node:child_process');

function defaultLog(message) {
  console.log(message);
}

function startContainerSystemIfNeeded({ log = defaultLog } = {}) {
  log('container service is not responding; running `container system start`');
  const startResult = spawnSync('container', ['system', 'start'], {
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (startResult.status !== 0) {
    log(`container system start failed (exit ${startResult.status}); continuing anyway`);
    return false;
  }
  return true;
}

function listContainersJson({ log = defaultLog, allowStart = true, retries = 15 } = {}) {
  const runList = () => spawnSync('container', ['list', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf-8',
  });

  let listResult = runList();
  if (listResult.status === 0) return listResult;

  if (allowStart && startContainerSystemIfNeeded({ log })) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      listResult = runList();
      if (listResult.status === 0) return listResult;
      spawnSync('sleep', ['1'], { stdio: 'ignore' });
    }
  }

  return listResult;
}

module.exports = {
  listContainersJson,
  startContainerSystemIfNeeded,
};

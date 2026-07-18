#!/usr/bin/env node

// Backward-compatible command: `pic-proxy` is equivalent to `pic --proxy`.
process.env.PIC_PROXY_MODE = '1';
process.env.PIC_COMMAND_NAME = 'pic-proxy';
require('./pic-runner.cjs');

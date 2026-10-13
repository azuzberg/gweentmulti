const { spawn } = require('node:child_process');

const child = spawn(process.execPath, [
  require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: { ...process.env, GWENT_TEST_HTTPS: '1' },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.once('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});

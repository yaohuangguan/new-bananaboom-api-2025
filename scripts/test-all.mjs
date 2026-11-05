import { spawnSync } from 'node:child_process';

// JWT compatibility is a native Node test because it exercises both legacy
// and staged signing modes without loading the MongoDB-backed Express app.
const keyringTest = spawnSync(
  process.execPath,
  ['--test', 'tests/jwtKeyring.test.mjs'],
  { stdio: 'inherit', windowsHide: true }
);
if (keyringTest.status !== 0) process.exit(keyringTest.status || 1);
for (const config of ['jest.config.cjs', 'jest.brain.config.cjs']) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      '--config',
      config,
      '--runInBand',
      '--detectOpenHandles'
    ],
    { stdio: 'inherit', windowsHide: true }
  );
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}

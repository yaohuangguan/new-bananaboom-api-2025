import { spawnSync } from 'node:child_process';
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

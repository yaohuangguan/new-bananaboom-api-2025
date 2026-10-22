module.exports = {
  testEnvironment: 'node', transform: {}, testMatch: ['**/tests/brain/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/env.js'], setupFilesAfterEnv: ['<rootDir>/tests/brain/setup.js'],
  maxWorkers: 1, testTimeout: 30000
};

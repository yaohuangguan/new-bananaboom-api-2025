module.exports = {
    testEnvironment: 'node',
    setupFilesAfterEnv: ['./tests/setup.js'], // 指定刚才的配置文件
    testTimeout: 10000 // 10秒超时
  };
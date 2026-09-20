// jest.config.cjs

/** @type {import('jest').Config} */
module.exports = {
    // 1. 告诉 Jest 现在的环境是 Node
    testEnvironment: 'node',

    // 2. 🔥 核心：因为我们用了 --experimental-vm-modules
    // 这里必须留空，防止 Jest 试图用 Babel 去乱转义 ESM 代码
    transform: {},

    // 3. 匹配测试文件
    testMatch: ['**/tests/**/*.test.js'],

    // 4. 忽略目录
    testPathIgnorePatterns: ['/node_modules/'],

    // 5. 其它设置
    verbose: true,
    testTimeout: 10000,
    // ✅ 确保这里指向了你的 setup.js
    setupFiles: ['<rootDir>/tests/env.js'],
    maxWorkers: 1,
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
};
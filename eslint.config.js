import js from '@eslint/js';
import globals from 'globals';

export default [
  // 1. 全局忽略 (替代 .eslintignore)
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', '.idea/', '.vscode/']
  },

  // 2. 加载 ESLint 推荐配置
  js.configs.recommended,

  // 3. 自定义配置
  {
    // 指定这些规则生效的文件范围
    files: ['**/*.js', '**/*.mjs'],

    languageOptions: {
      // Node 22 支持最新的 ES 标准
      ecmaVersion: 'latest',
      // 告诉 ESLint 我们在用 ESM (import/export)
      sourceType: 'module',
      
      // 🔥 关键：定义全局变量 (替代 env: { node: true, jest: true })
      globals: {
        ...globals.node, // 识别 process, console, __dirname 等
        ...globals.jest, // 识别 describe, it, expect, jest 等
      }
    },

    // 4. 规则微调
    rules: {
      // ⚠️ 彻底关掉 import 路径检查
      // 在 pnpm + ESM 下，让 Node.js 运行时自己去报错，ESLint 不要插手
      'import/no-unresolved': 'off',
      'node/no-missing-import': 'off',

      // 变量未使用：警告而不是报错
      'no-unused-vars': 'warn',

      // 允许使用 console (后端项目通常需要打印日志)
      'no-console': 'off',

      // 强制使用 const (如果变量没被修改过)
      'prefer-const': 'error'
    }
  }
];
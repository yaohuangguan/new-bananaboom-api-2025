// eslint.config.js
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', '.idea/', '.vscode/']
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      }
    },
    rules: {
      // 1. 关掉路径检查 (pnpm 下不准)
      'import/no-unresolved': 'off',
      'node/no-missing-import': 'off',
      'no-useless-escape': 'off',

      // 2. 允许 console (后端常用于打日志)
      'no-console': 'off',

      // 3. 智能的“未定义变量”检查 🔥🔥🔥 (核心修改)
      'no-unused-vars': [
        'warn',
        { 
          // 忽略参数：以 _ 开头，或者叫 err, req, res, next, error
          'argsIgnorePattern': '^_|req|res|next|err|error', 
          // 忽略变量：以 _ 开头
          'varsIgnorePattern': '^_',
          // 忽略 catch 里的 error
          'caughtErrorsIgnorePattern': '^_|err|error' 
        }
      ],

     // 🔥 修改这一行：允许解构时混合使用
     'prefer-const': [
      'error',
      {
        'destructuring': 'all' 
      }
    ]
    }
  }
];
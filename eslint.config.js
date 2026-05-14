import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // examples/ 是第三方参考项目快照(lokus / headless-tree / file-tree-alternative
    // / mcp-demo-plugin / sample-plugin),不属于 Continuo 自己的代码,不参与 lint。
    // dist-electron / out / out-pack / coverage / test-results 是构建/测试产物。
    ignores: [
      'out',
      'out-pack',
      'dist',
      'dist-electron',
      'node_modules',
      'coverage',
      'test-results',
      'playwright-report',
      'examples',
      '*.config.js',
      '*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 用 _ 前缀显式标记"故意未用"的参数/变量(占位、解构剩余、catch err 等),
      // 这是 TS 生态最常见约定。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // 中文注释和字符串里偶有全角空格(　),默认 skipStrings/skipComments
      // 已开,这里再 skipTemplates 让模板字符串也放过。
      'no-irregular-whitespace': [
        'error',
        {
          skipStrings: true,
          skipComments: true,
          skipRegExps: true,
          skipTemplates: true,
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: '19' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  {
    // src/design/ 是 Nous shell-ui 的同步副本(详见 scripts/sync-design.mjs),
    // 不允许 LM 单方面改写规则。Nous 上游有空 interface 占位的设计意图(如
    // ScrollArea/Separator 仅做语义包装),这里放过。
    files: ['src/design/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Playwright fixture 的 `({}, use) => ...` 是官方文档惯用模式,
    // 表示"该 fixture 不依赖其他 fixture"。
    files: ['tests/e2e/fixtures/**/*.{ts,tsx}'],
    rules: {
      'no-empty-pattern': 'off',
    },
  },
  {
    files: ['electron/**/*.ts', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);

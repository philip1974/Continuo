// Quick Open 文件打分(VSCode fuzzyScorer;BDD: src/__tests__/quick-open-fuzzy-score/):输入完整文件名 → 该文件排第一;
// 多个词(空格)按段匹配、段序无关。第五十三轮审计:`CodeEditor.tsx` 回车打开的是 editor-tab-git.spec.tsx,`quick open` 0 结果。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const FILES = [
  'src/__tests__/editor-tab-git/editor-tab-git.spec.tsx',
  'src/__tests__/code-editor/code-editor-theme.spec.tsx',
  'src/panels/Editor/CodeEditorPane.tsx',
  'src/panels/Editor/CodeEditor.tsx',
  'src/plugins/quick-open/QuickOpenModal.tsx',
  'src/plugins/quick-open/store.ts',
  'src/stores/workspace.store.ts',
  'src/index.ts',
  'src/panels/Explorer/index.ts',
];

test('完整文件名排第一;多个词按段匹配', async ({ window, workspaceRoot }) => {
  for (const rel of FILES) {
    mkdirSync(path.dirname(path.join(workspaceRoot, rel)), { recursive: true });
    writeFileSync(path.join(workspaceRoot, rel), '');
  }
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  const items = window.locator('.wm-modal-content li');
  await expect(window.locator('.wm-modal-content')).toContainText('CodeEditor.tsx', { timeout: 10_000 });

  await input.fill('CodeEditor.tsx');
  await expect(items.first()).toHaveAttribute('title', 'src/panels/Editor/CodeEditor.tsx');
  await input.fill('codeeditor');
  await expect(items.first()).toHaveAttribute('title', 'src/panels/Editor/CodeEditor.tsx');
  await expect(items.nth(1)).toHaveAttribute('title', 'src/panels/Editor/CodeEditorPane.tsx');
  await input.fill('index.ts');
  await expect(items.first()).toHaveAttribute('title', 'src/index.ts');
  await input.fill('quick open');
  await expect(items.first()).toHaveAttribute('title', 'src/plugins/quick-open/QuickOpenModal.tsx');
  await input.fill('open quick');
  await expect(items.first()).toHaveAttribute('title', 'src/plugins/quick-open/QuickOpenModal.tsx');
  // 文件名命中只高亮文件名
  await input.fill('CodeEditor');
  await expect(items.first().locator('mark')).toHaveText(['CodeEditor']);

  await input.fill('CodeEditor.tsx');
  await expect(items.first()).toHaveAttribute('title', 'src/panels/Editor/CodeEditor.tsx');
  await input.press('Enter');
  await expect(window.getByRole('tab', { name: /CodeEditor\.tsx/ })).toBeVisible({ timeout: 10_000 });
});

// 真实 editor 编辑流程:打开 .ts → CodeMirror 内输入 → dirty 显示 →
// Ctrl+S 保存 → 磁盘内容更新 + dirty 清.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_TABS,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';

test('打开 a.ts → 输入 → dirty 圆点 → Ctrl+S → 磁盘更新 + dirty 清', async ({
  window,
  workspaceRoot,
}) => {
  // 打开 src/a.ts(初始内容 'export const a = 1;\n')
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // CodeMirror .cm-content 聚焦 + 等内容渲染
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();

  // 移到末尾再输入,避免在中间插字
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(' // edit-by-e2e');

  // dirty 状态:EditorHeader 紧凑模式右侧的「未保存修改」蓝点
  const dirtyDot = window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR);
  await expect(dirtyDot).toBeVisible({ timeout: 5_000 });

  // Cmd/Ctrl+S 由 EditorPanel 的 onKeyDown 处理(不是全局 useCommandHotkeys),
  // 必须在 panel 内的元素上发 keypress 才能冒泡到容器 onKeyDown.
  await cm.press('ControlOrMeta+KeyS');

  // 磁盘内容包含新增字符串
  await expect(async () => {
    const content = await readFile(
      path.join(workspaceRoot, 'src/a.ts'),
      'utf8',
    );
    expect(content).toContain('edit-by-e2e');
  }).toPass({ timeout: 5_000 });

  // dirty 圆点消失
  await expect(dirtyDot).toBeHidden({ timeout: 5_000 });
});

test('编辑后切到另一文件 → 切回保留 dirty 状态', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(' // dirty');

  // 切到 b.ts
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  // 切回 a.ts(从 TabNav 点)— TabNavItem 包含 a.ts
  const aTab = window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .filter({ hasText: 'a.ts' });
  await aTab.click();

  // dirty 状态(active=a.ts,EditorHeader 切到对应 tab)
  // tablist 模式 → TabNavItem data-dirty='true'
  const aTabItem = window
    .locator('.wm-tab-nav-item')
    .filter({ has: window.locator('text=a.ts') });
  await expect(aTabItem).toHaveAttribute('data-dirty', 'true');
});

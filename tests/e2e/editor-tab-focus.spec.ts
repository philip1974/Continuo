// 编辑器 tab 的焦点归属(VSCode 同):键盘 ←/→ + Enter / Space 激活 tab 后焦点留在 tab,Tab 进入编辑区;
// 鼠标点只读图片 / Markdown 预览的 tab,焦点不掉到 body。
// BDD: src/__tests__/keyboard-focus-parity/(第 7 条)、src/__tests__/editor-header/
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_PREVIEW, editorModeButton, editorTab, openWorkspaceFile } from './helpers/editor';

const focusIsBody = (window: import('@playwright/test').Page) =>
  window.evaluate(() => document.activeElement === document.body || document.activeElement == null);

for (const key of ['Enter', ' '] as const) {
  test(`键盘 ← 移到另一 tab 后按 ${key === ' ' ? 'Space' : 'Enter'} 激活 → 焦点留在该 tab;Tab 进入编辑区`, async ({ window }) => {
    await openWorkspaceFile(window, ['src', 'a.ts']);
    await openWorkspaceFile(window, ['b.ts']);
    const aTab = editorTab(window, 'a.ts');
    const bTab = editorTab(window, 'b.ts');
    await expect(bTab).toHaveAttribute('aria-selected', 'true');
    await bTab.focus();

    await window.keyboard.press('ArrowLeft');
    await expect(aTab).toBeFocused();
    await window.keyboard.press(key === ' ' ? 'Space' : 'Enter');
    await expect(aTab).toHaveAttribute('aria-selected', 'true');
    await expect(window.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
    // 激活后多等几帧(DockShell 激活 effect / 重挂)再断言焦点仍在 tab
    await window.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(aTab).toBeFocused();
    expect(await focusIsBody(window)).toBe(false);

    await window.keyboard.press('Tab');
    await expect(window.locator('.cm-content')).toBeFocused();
  });
}

test('鼠标点只读图片 tab → 焦点进图片视图(不掉到 body)', async ({ window, workspaceRoot }) => {
  mkdirSync(path.join(workspaceRoot, 'img'));
  writeFileSync(path.join(workspaceRoot, 'img', 'q.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await openWorkspaceFile(window, ['img', 'q.png']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await expect(window.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });

  await editorTab(window, 'q.png').click();
  await expect(window.locator('[data-editor-focus-target]')).toBeFocused({ timeout: 5_000 });
});

test('鼠标点 Markdown 预览 tab → 焦点留在该 tab(不掉到 body)', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await expect(window.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  await window.locator('.cm-content').click();

  const readme = editorTab(window, 'README.md');
  await readme.click();
  await expect(readme).toHaveAttribute('aria-selected', 'true');
  await window.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await focusIsBody(window)).toBe(false);
  await expect(readme).toBeFocused();
});

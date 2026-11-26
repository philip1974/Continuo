// 20 个 tab 溢出时激活 tab 始终在 tab 栏可视区内;窗口变窄后仍校正(VSCode revealActiveTab)。
// BDD: src/__tests__/editor-header/
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';

const EDITOR_TAB_LABELS = ['编辑器标签', 'Editor tabs', '편집기 탭'];

async function activeTabInView(window: Page): Promise<boolean> {
  return window.evaluate((labels) => {
    const list = [...document.querySelectorAll<HTMLElement>('[role=tablist]')].find((el) =>
      labels.includes(el.getAttribute('aria-label') ?? ''),
    );
    const active = list?.querySelector<HTMLElement>('[role=tab][aria-selected="true"]');
    if (!list || !active) return false;
    const item = active.closest<HTMLElement>('.wm-tab-nav-item') ?? active;
    const l = list.getBoundingClientRect();
    const t = item.getBoundingClientRect();
    return t.left >= l.left - 1 && t.right <= l.right + 1;
  }, EDITOR_TAB_LABELS);
}

test('打开 20 个文件 → 最后打开的 tab 可见;缩窄窗口后仍可见', async ({ window, workspaceRoot, electronApp }) => {
  for (let i = 1; i <= 20; i++) {
    writeFileSync(path.join(workspaceRoot, 'src', `file-${String(i).padStart(2, '0')}.ts`), `export const f${i} = ${i};\n`);
  }
  await window.locator('text=src').first().click();
  for (let i = 1; i <= 20; i++) {
    const p = path.join(workspaceRoot, 'src', `file-${String(i).padStart(2, '0')}.ts`);
    await window.locator(`[role=treeitem][title="${p}"]`).dblclick();
    await expect(window.locator('.cm-content')).toContainText(`f${i} = ${i}`, { timeout: 10_000 });
  }
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(20);
  await expect.poll(() => activeTabInView(window)).toBe(true);

  // 缩窄窗口:tab 栏变窄,激活 tab 仍被滚入可视区
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    const [, h] = w.getSize();
    w.setSize(800, h!);
  });
  await expect.poll(() => activeTabInView(window)).toBe(true);

  // 切到第一个 tab(已在左侧外;用 DOM click,不让 Playwright 先把它滚进视野)→ 滚回可见
  await window.evaluate((labels) => {
    const list = [...document.querySelectorAll<HTMLElement>('[role=tablist]')].find((el) =>
      labels.includes(el.getAttribute('aria-label') ?? ''),
    );
    list?.querySelector<HTMLElement>('[role=tab]')?.click();
  }, EDITOR_TAB_LABELS);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => activeTabInView(window)).toBe(true);
});

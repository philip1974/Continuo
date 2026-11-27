// 资源管理器键盘焦点(对齐 VSCode 列表 / 树):
// - 焦点行被「折叠全部」隐藏 → 焦点移到最近的显示中祖先,Tab 仍能进树
// - 焦点行被外部删除(终端 rm 等)→ 焦点与 DOM 焦点移到原下标处的行,不掉到 body,方向键照常
// - PageDown / PageUp(list.focusPageDown / focusPageUp):先到可视区末行 / 首行,再按页移动
// - 文件上按 → 无动作(list.expand 的 when 不含叶子)
// BDD: src/__tests__/explorer-tree/
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_COLLAPSE_ALL, explorerSidebar, explorerTreeItem, expandTreeItem } from './helpers/explorer';

async function realFocus(window: Page): Promise<void> {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

/** DOM 焦点所在元素:treeitem → 其 aria-label;否则标签名。 */
const activeName = (window: Page) =>
  window.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    return a.getAttribute('role') === 'treeitem' ? `treeitem:${a.getAttribute('aria-label')}` : a.tagName;
  });
const tabStops = (window: Page) =>
  window.evaluate(() =>
    [...document.querySelectorAll('[role=tree] [role=treeitem][tabindex="0"]')].map((el) => el.getAttribute('aria-label')),
  );

test('「折叠全部」隐藏焦点行 → 焦点移到祖先,Tab 进树落在它上', async ({ window }) => {
  await realFocus(window);
  await expandTreeItem(window, /^src$/);
  await explorerTreeItem(window, /^b\.ts$/).click();
  await expect.poll(() => activeName(window)).toBe('treeitem:b.ts');
  const collapse = explorerSidebar(window).getByRole('button', { name: EXPLORER_COLLAPSE_ALL });
  await collapse.click();
  await expect(explorerTreeItem(window, /^b\.ts$/)).toHaveCount(0);
  expect(await tabStops(window)).toEqual(['src']);
  // 从「折叠全部」按钮往后 Tab,应能进到树(落在 src)
  await collapse.focus();
  let reached: string | null = null;
  for (let i = 0; i < 8 && reached !== 'treeitem:src'; i++) {
    await window.keyboard.press('Tab');
    reached = await activeName(window);
  }
  expect(reached).toBe('treeitem:src');
});

test('外部删除焦点行 → DOM 焦点移到原位置的行,方向键照常', async ({ window, workspaceRoot }) => {
  await realFocus(window);
  for (const n of ['x1.md', 'x2.md', 'x3.md']) writeFileSync(path.join(workspaceRoot, n), `${n}\n`);
  await expect(explorerTreeItem(window, /^x3\.md$/)).toBeVisible({ timeout: 10_000 });
  await explorerTreeItem(window, /^x2\.md$/).click();
  await expect.poll(() => activeName(window)).toBe('treeitem:x2.md');
  unlinkSync(path.join(workspaceRoot, 'x2.md'));
  await expect(explorerTreeItem(window, /^x2\.md$/)).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => activeName(window)).toBe('treeitem:x3.md');
  expect(await tabStops(window)).toEqual(['x3.md']);
  await window.keyboard.press('ArrowUp');
  await expect.poll(() => activeName(window)).toBe('treeitem:x1.md');
});

test('PageDown / PageUp 按可视区移动焦点;文件上 → 不动', async ({ window, workspaceRoot }) => {
  await realFocus(window);
  const names = Array.from({ length: 80 }, (_, i) => `p${String(i).padStart(2, '0')}.txt`);
  for (const n of names) writeFileSync(path.join(workspaceRoot, n), 'x\n');
  await expect(explorerTreeItem(window, /^p00\.txt$/)).toBeVisible({ timeout: 10_000 });
  await explorerTreeItem(window, /^p00\.txt$/).click();
  await expect.poll(() => activeName(window)).toBe('treeitem:p00.txt');

  // → 在文件上无动作
  await window.keyboard.press('ArrowRight');
  await window.waitForTimeout(100);
  expect(await activeName(window)).toBe('treeitem:p00.txt');

  const scroller = explorerSidebar(window).locator('[role=tree]').locator('xpath=..');
  const lastVisible = () =>
    scroller.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('[role=treeitem]')].filter((r) => {
        const b = r.getBoundingClientRect();
        return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
      });
      rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      return rows.at(-1)?.getAttribute('aria-label') ?? null;
    });

  // 第一次 PageDown:可视区末行,不滚
  const expectedLast = await lastVisible();
  expect(expectedLast).not.toBe('p00.txt');
  await window.keyboard.press('PageDown');
  await expect.poll(() => activeName(window)).toBe(`treeitem:${expectedLast}`);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(explorerTreeItem(window, new RegExp(`^${expectedLast!.replace('.', '\\.')}$`))).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // 第二次:滚一页,落在新一页的末行
  await window.keyboard.press('PageDown');
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => (await activeName(window)) === `treeitem:${await lastVisible()}`).toBe(true);
  expect(await activeName(window)).not.toBe(`treeitem:${expectedLast}`);

  // PageUp:先到可视区首个完整可见行
  const before = await activeName(window);
  await window.keyboard.press('PageUp');
  await expect.poll(() => activeName(window)).not.toBe(before);
  const firstVisible = await scroller.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll('[role=treeitem]')].filter((r) => r.getBoundingClientRect().top >= box.top - 0.5);
    rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return rows[0]?.getAttribute('aria-label') ?? null;
  });
  expect(await activeName(window)).toBe(`treeitem:${firstVisible}`);
});

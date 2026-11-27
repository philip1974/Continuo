// 搜索结果树与 ⌘P 列表的 PageDown / PageUp(VSCode list.focusPageDown / Up、Quick Input 同):先到可视区末 / 首行,再按可视行数
// 翻页;活动行始终在视口内(aria-activedescendant 不消失)。BDD: src/__tests__/workspace-search/、src/__tests__/picker-shared/(规则 6)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

/** owner 的 aria-activedescendant 指向的行:下标(data-row-index 或 option id 尾号)与是否完全在 scroller 视口内。 */
async function activeRow(window: Page, owner: Locator, scroller: Locator): Promise<{ index: number; inView: boolean } | null> {
  const id = await owner.getAttribute('aria-activedescendant');
  if (!id) return null;
  const row = window.locator(`[id="${id}"]`);
  const r = (await row.boundingBox())!;
  const s = (await scroller.boundingBox())!;
  return { index: Number(id.match(/(\d+)$/)![1]), inView: r.y >= s.y - 0.5 && r.y + r.height <= s.y + s.height + 0.5 };
}

test('搜索结果树:PageDown 先到可视区末行再翻页,PageUp 反向;活动行始终可见', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'pages.txt'), Array.from({ length: 120 }, (_, i) => `needle ${i}`).join('\n'));
  await waitForTestHooks(window);
  await window.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: /^(搜索|Search|검색)$/ });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('needle');
  const tree = window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });
  await expect(tree.getByRole('treeitem').nth(5)).toBeVisible({ timeout: 10_000 });
  await window.keyboard.press('ArrowDown');
  await expect(tree).toBeFocused();
  expect((await activeRow(window, tree, tree))!.index).toBe(0);

  await window.keyboard.press('PageDown');
  const first = (await activeRow(window, tree, tree))!;
  expect(first.inView).toBe(true);
  expect(first.index).toBeGreaterThan(3);
  // 已在末行:翻一页,原末行成为首行
  await window.keyboard.press('PageDown');
  await expect.poll(async () => (await activeRow(window, tree, tree))?.inView).toBe(true);
  const second = (await activeRow(window, tree, tree))!;
  expect(second.index).toBe(first.index * 2);
  await window.keyboard.press('PageUp');
  await expect.poll(async () => (await activeRow(window, tree, tree))?.index).toBe(first.index);
  expect((await activeRow(window, tree, tree))!.inView).toBe(true);
  await window.keyboard.press('PageUp');
  await window.keyboard.press('PageUp');
  await expect.poll(async () => (await activeRow(window, tree, tree))?.index).toBe(0);
});

test('⌘P:PageDown / PageUp 按可视行数移动选中项,选中项滚入视口', async ({ window, workspaceRoot }) => {
  for (let i = 0; i < 60; i++) writeFileSync(path.join(workspaceRoot, `page-${String(i).padStart(2, '0')}.txt`), 'x');
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await input.fill('page-');
  const listbox = window.locator('.wm-modal-content [role="listbox"]');
  await expect(listbox.getByRole('option').nth(10)).toBeVisible({ timeout: 10_000 });
  const scroller = listbox.locator('xpath=..');
  await expect(input).toHaveAttribute('aria-activedescendant', /-0$/);

  await window.keyboard.press('PageDown');
  await expect.poll(async () => (await activeRow(window, input, scroller))?.index ?? 0).toBeGreaterThan(3);
  const first = (await activeRow(window, input, scroller))!;
  expect(first.inView).toBe(true);
  await window.keyboard.press('PageDown');
  await expect.poll(async () => (await activeRow(window, input, scroller))?.index).toBeGreaterThan(first.index);
  await expect.poll(async () => (await activeRow(window, input, scroller))?.inView).toBe(true);
  await window.keyboard.press('PageUp');
  await expect.poll(async () => (await activeRow(window, input, scroller))?.inView).toBe(true);
  for (let i = 0; i < 4; i++) await window.keyboard.press('PageUp');
  await expect(input).toHaveAttribute('aria-activedescendant', /-0$/);
});

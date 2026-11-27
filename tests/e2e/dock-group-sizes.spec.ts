// 只用鼠标调整 dock 组大小(对齐 VSCode 编辑器组;BDD: src/__tests__/dock-group-sizes/):
// 双击组之间的分隔条 → 等分;双击 dock tab → 展开该组 / 再双击等分;tab 右键「最大化组 / 取消最大化组」。
// 先打开文件并 ⌘\ 拆出第二个编辑器组(左「editor」| 右「editor:N」)。真实鼠标拖动 / 双击 / 右键。
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { openTreeItem } from './helpers/explorer';

const MAXIMIZE = /^(最大化组|Maximize Group|그룹 최대화)$/;
const UNMAXIMIZE = /^(取消最大化组|Unmaximize Group|그룹 최대화 해제)$/;
const editorTab = (window: Page): Locator => window.locator('[role=tab][data-panel-id="editor"]');
/** 拆分出的第二个编辑器组的 dock tab(变量名沿用「另一组」)。 */
const terminalTab = (window: Page): Locator => window.locator('[role=tab][data-panel-id^="editor:"]').first();

/** 左右两个编辑器组所在 dock 组的宽度(editor = 左组,terminal = 拆出的右组)。 */
const widths = (window: Page) =>
  window.evaluate(() => {
    const groupOf = (sel: string) => document.querySelector(sel)?.closest('.dv-groupview') as HTMLElement | null;
    const e = groupOf('[role=tab][data-panel-id="editor"]');
    const t = groupOf('[role=tab][data-panel-id^="editor:"]');
    return { editor: Math.round(e?.getBoundingClientRect().width ?? -1), terminal: Math.round(t?.getBoundingClientRect().width ?? -1) };
  });

/** 两组之间的那条竖向分隔条(位于左组右缘、可见)。 */
async function sashBetween(window: Page): Promise<Locator> {
  const index = await window.evaluate(() => {
    const e = document.querySelector('[role=tab][data-panel-id="editor"]')?.closest('.dv-groupview')?.getBoundingClientRect();
    const sashes = [...document.querySelectorAll('.dv-sash')];
    return sashes.findIndex((s) => {
      const r = s.getBoundingClientRect();
      return e !== undefined && r.width > 0 && r.height > 50 && Math.abs(r.left + r.width / 2 - e.right) < 8;
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  return window.locator('.dv-sash').nth(index);
}

async function ready(window: Page) {
  await waitForTestHooks(window);
  await openTreeItem(window, 'README.md');
  const cm = window.locator('[data-editor-panel-root] .cm-content').first();
  await expect(cm).toBeVisible({ timeout: 15_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+Backslash');
  await expect(editorTab(window)).toBeVisible({ timeout: 15_000 });
  await expect(terminalTab(window)).toBeVisible({ timeout: 15_000 });
}

test('拖歪分隔条后双击它 → 两组等宽', async ({ window }) => {
  await ready(window);
  const sash = await sashBetween(window);
  const box = (await sash.boundingBox())!;
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  for (let i = 1; i <= 8; i += 1) await window.mouse.move(box.x + box.width / 2 - 25 * i, box.y + box.height / 2);
  await window.mouse.up();
  await expect.poll(async () => { const w = await widths(window); return w.terminal - w.editor; }).toBeGreaterThan(100);

  const after = (await sash.boundingBox())!;
  await window.mouse.dblclick(after.x + after.width / 2, after.y + after.height / 2);
  await expect.poll(async () => { const w = await widths(window); return Math.abs(w.terminal - w.editor); }).toBeLessThanOrEqual(2);
});

test('双击 dock tab → 展开该组(另一组缩到最小);再双击 → 等分', async ({ window }) => {
  await ready(window);
  const before = await widths(window);
  await terminalTab(window).dblclick();
  await expect.poll(async () => (await widths(window)).editor).toBeLessThan(before.editor - 100);
  const expanded = await widths(window);
  expect(expanded.terminal).toBeGreaterThan(expanded.editor * 3);

  await terminalTab(window).dblclick();
  await expect.poll(async () => { const w = await widths(window); return Math.abs(w.terminal - w.editor); }).toBeLessThanOrEqual(2);
});

test('tab 右键「最大化组」→ 只剩该组;再右键「取消最大化组」→ 还原', async ({ window }) => {
  await ready(window);
  await editorTab(window).click({ button: 'right' });
  await window.getByRole('menuitem', { name: MAXIMIZE }).click();
  // dockview 最大化:其它组的视图宽缩到 0(元素仍在)
  await expect.poll(async () => (await widths(window)).terminal).toBe(0);
  await expect(window.getByTestId('tab-maximize-indicator')).toBeVisible();

  await editorTab(window).click({ button: 'right' });
  await window.getByRole('menuitem', { name: UNMAXIMIZE }).click();
  await expect.poll(async () => (await widths(window)).terminal).toBeGreaterThan(100);
  await expect(window.getByTestId('tab-maximize-indicator')).toHaveCount(0);
});

test('双击编辑器文件 tab(常驻)→ 展开该编辑器组;再双击 → 等分', async ({ window }) => {
  await ready(window);
  const fileTab = window.locator('[data-editor-panel-root]').first().getByRole('tab', { name: /^README\.md/ });
  await fileTab.dblclick();
  await expect.poll(async () => { const w = await widths(window); return w.editor - w.terminal; }).toBeGreaterThan(300);
  await fileTab.dblclick();
  await expect.poll(async () => { const w = await widths(window); return Math.abs(w.terminal - w.editor); }).toBeLessThanOrEqual(2);
});

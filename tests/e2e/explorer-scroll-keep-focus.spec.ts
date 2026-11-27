// 资源管理器树:鼠标滚轮把焦点行滚出视口后 DOM 焦点不丢(VSCode 列表同):↓ / Shift+F10 / ⌘C 仍作用于该行。
// 虚拟列表 rangeExtractor 常驻焦点行(BDD: src/__tests__/explorer-tree/folder-tree-focus-pinned.spec.tsx)。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test as base, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

const name = (i: number) => `f${String(i).padStart(4, '0')}.txt`;
// 1200 个文件在应用启动前建好(启动后再建会触发上千次 watcher 刷新,与本规范无关)
const test = base.extend({
  workspaceRoot: async ({ workspaceRoot }, use) => {
    const dir = path.join(workspaceRoot, 'big');
    mkdirSync(dir);
    for (let i = 0; i < 1200; i++) writeFileSync(path.join(dir, name(i)), '');
    await use(workspaceRoot);
  },
});

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

const rowOf = (window: Page, p: string) => window.locator(`[role=treeitem][title="${p}"]`);
const activeTitle = (window: Page) =>
  window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el === null || el === document.body ? 'BODY' : (el.getAttribute('title') ?? el.tagName);
  });

async function focusThenWheelAway(window: Page, root: string): Promise<string> {
  const dir = path.join(root, 'big');
  const big = rowOf(window, dir);
  await expect(big).toBeVisible({ timeout: 10_000 });
  // 单击目录 = 展开(VSCode 同)
  await big.click();
  await expect(big).toHaveAttribute('aria-expanded', 'true');
  const target = path.join(dir, name(2));
  const row = rowOf(window, target);
  await row.click();
  await expect(row).toBeFocused();
  // 鼠标停在树上往下滚约 500px(远超 overscan):焦点行已不在视口
  const box = (await row.boundingBox())!;
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.wheel(0, 500);
  await expect(rowOf(window, path.join(dir, name(40)))).toBeVisible();
  await window.waitForTimeout(200);
  expect(await activeTitle(window)).toBe(target);
  return target;
}

test('滚出视口后按 ↓ → 焦点移到下一行', async ({ window, workspaceRoot }) => {
  const target = await focusThenWheelAway(window, workspaceRoot);
  await window.keyboard.press('ArrowDown');
  const next = path.join(path.dirname(target), name(3));
  await expect(rowOf(window, next)).toBeFocused();
});

test('滚出视口后 Shift+F10 → 打开该行右键菜单', async ({ window, workspaceRoot }) => {
  await focusThenWheelAway(window, workspaceRoot);
  await window.keyboard.press('Shift+F10');
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: EXPLORER_RENAME })).toBeVisible();
  await window.keyboard.press('Escape');
});

test('滚出视口后 ⌘C / ⌘V → 复制该行', async ({ window, workspaceRoot }) => {
  const target = await focusThenWheelAway(window, workspaceRoot);
  await window.keyboard.press('ControlOrMeta+c');
  await window.keyboard.press('ControlOrMeta+v');
  const copy = path.join(path.dirname(target), 'f0002 copy.txt');
  await expect.poll(() => existsSync(copy)).toBe(true);
});

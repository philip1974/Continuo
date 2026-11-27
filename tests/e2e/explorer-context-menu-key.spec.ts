// 资源管理器树:Shift+F10 / 菜单键打开焦点行的右键菜单(VSCode 列表同),菜单定位在该行,Esc 关闭后焦点回到该行
//(BDD: src/__tests__/explorer-tree/ 键盘操作)。
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_NEW_FILE, EXPLORER_RENAME, EXPLORER_TRASH } from './helpers/explorer';

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

test('焦点行上 Shift+F10 → 打开该行菜单(定位在行处);Esc → 焦点回到该行', async ({ window, workspaceRoot }) => {
  const readme = window.locator(`[role=treeitem][title="${path.join(workspaceRoot, 'README.md')}"]`);
  await readme.click();
  await expect(readme).toBeFocused();

  await window.keyboard.press('Shift+F10');
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: EXPLORER_RENAME })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: EXPLORER_TRASH })).toBeVisible();
  // 文件行菜单不含「新建文件」
  await expect(menu.getByRole('menuitem', { name: EXPLORER_NEW_FILE })).toHaveCount(0);
  // 菜单左上角贴着该行的左下角附近
  const rowBox = (await readme.boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.y - (rowBox.y + rowBox.height))).toBeLessThan(40);

  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(readme).toBeFocused();
});

test('目录行上 Shift+F10 → 目录菜单(含「新建文件」);Esc → 焦点回到该行', async ({ window, workspaceRoot }) => {
  const src = window.locator(`[role=treeitem][title="${path.join(workspaceRoot, 'src')}"]`);
  await src.click();
  await expect(src).toBeFocused();
  await window.keyboard.press('Shift+F10');
  const menu = window.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: EXPLORER_NEW_FILE })).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(src).toBeFocused();
});

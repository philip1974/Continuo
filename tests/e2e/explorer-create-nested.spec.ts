// 新建文件 / 文件夹时一次输入嵌套路径(VSCode 同款逐级创建中间目录);⌘Z 撤销整条链,已存在的目录不动。
// BDD: src/__tests__/explorer-create-nested/
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FILE_PLACEHOLDER,
  EXPLORER_NEW_FOLDER,
  EXPLORER_NEW_FOLDER_PLACEHOLDER,
} from './helpers/explorer';

const rowOf = (window: import('@playwright/test').Page, p: string) =>
  window.locator(`[role=treeitem][title="${p}"]`);

const kindOf = (p: string): Promise<'file' | 'dir' | null> =>
  stat(p)
    .then((s) => (s.isDirectory() ? ('dir' as const) : ('file' as const)))
    .catch(() => null);

const UNDO = 'ControlOrMeta+z';

// 关掉 CDP 焦点模拟:焦点断言反映真实的焦点落点(不被模拟成「窗口总是聚焦」掩盖)。
test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});
const TRASH_BUTTON = /^(移到废纸篓|Move to Trash|휴지통으로 이동)$/;

test('右键 src →「新建文件」输入 na/nb/nc.ts:逐级建出,树展开到新文件并选中、编辑器打开;⌘Z 确认后撤销整条链,src 保留', async ({
  window,
  workspaceRoot,
}) => {
  const srcDir = path.join(workspaceRoot, 'src');
  const src = rowOf(window, srcDir);
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_NEW_FILE }).click();
  const input = window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
  await input.fill('na/nb/nc.ts');
  await input.press('Enter');

  const leaf = path.join(srcDir, 'na', 'nb', 'nc.ts');
  await expect.poll(() => kindOf(leaf)).toBe('file');
  await expect(input).toHaveCount(0);
  await expect(window.locator('header').first()).toContainText('nc.ts', { timeout: 10_000 });
  const leafRow = rowOf(window, leaf);
  await expect(leafRow).toBeVisible({ timeout: 5_000 });
  await expect(leafRow).toHaveAttribute('aria-selected', 'true');
  await expect(rowOf(window, path.join(srcDir, 'na'))).toHaveAttribute('aria-expanded', 'true');
  await expect(rowOf(window, path.join(srcDir, 'na', 'nb'))).toHaveAttribute('aria-expanded', 'true');

  await leafRow.click();
  await leafRow.press(UNDO);
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText(/[“「]na[”」]/);
  await expect(dialog.getByRole('button', { name: TRASH_BUTTON })).toBeFocused();
  await window.keyboard.press('Enter');
  await expect.poll(() => kindOf(path.join(srcDir, 'na'))).toBe(null);
  expect(await kindOf(srcDir)).toBe('dir');
  expect(await kindOf(path.join(srcDir, 'a.ts'))).toBe('file');
});

test('「新建文件夹」输入 da/db:逐级建出两个目录,展开到 db 并选中', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_NEW_FOLDER }).click();
  const input = window.getByRole('textbox', { name: EXPLORER_NEW_FOLDER_PLACEHOLDER });
  await input.fill('da/db');
  await input.press('Enter');
  const db = path.join(workspaceRoot, 'src', 'da', 'db');
  await expect.poll(() => kindOf(db)).toBe('dir');
  await expect(rowOf(window, db)).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
});

test('含 .. 的嵌套路径 → 输入框保留并提示无效名称,磁盘不动', async ({ window, workspaceRoot }) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_NEW_FILE }).click();
  const input = window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
  await input.fill('x/../../escape.ts');
  await input.press('Enter');
  await expect(window.getByRole('alert')).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeVisible();
  expect(await kindOf(path.join(workspaceRoot, 'src', 'x'))).toBe(null);
  expect(await kindOf(path.join(path.dirname(workspaceRoot), 'escape.ts'))).toBe(null);
});

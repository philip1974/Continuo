// 资源管理器文件操作撤销 / 重做(VSCode 同款:树聚焦时 ⌘Z / ⇧⌘Z,Win/Linux Ctrl+Z / Ctrl+Y)。
// BDD: src/__tests__/explorer-file-undo/
import { lstat, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_NEW_FILE, EXPLORER_NEW_FILE_PLACEHOLDER } from './helpers/explorer';

const rowOf = (window: import('@playwright/test').Page, p: string) =>
  window.locator(`[role=treeitem][title="${p}"]`);

const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false);

const UNDO = 'ControlOrMeta+z';
const REDO = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';

// 关掉 CDP 焦点模拟:焦点断言反映真实的焦点落点(不被模拟成「窗口总是聚焦」掩盖)。
test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

test('改名后在树里 ⌘Z 撤销:文件回原名、编辑器 tab 跟随、原项被选中;编辑器里的 ⌘Z 不撤销文件操作;⇧⌘Z 重做', async ({
  window,
  workspaceRoot,
}) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const renamedPath = path.join(workspaceRoot, 'src/renamed.ts');
  const a = rowOf(window, aPath);
  await a.click(); // 打开 a.ts
  await expect(window.locator('header').first()).toContainText('a.ts', { timeout: 10_000 });

  await a.press('F2');
  const input = window.locator('[role=treeitem] input');
  await expect(input).toBeFocused({ timeout: 5_000 });
  await input.fill('renamed.ts');
  await input.press('Enter');
  await expect.poll(() => exists(renamedPath)).toBe(true);
  await expect(window.locator('header').first()).toContainText('renamed.ts', { timeout: 5_000 });

  // 焦点在编辑器里:⌘Z 归编辑器,不撤销改名
  await window.locator('.cm-content').first().click();
  await window.keyboard.press(UNDO);
  await window.waitForTimeout(300);
  expect(await exists(renamedPath)).toBe(true);

  const renamed = rowOf(window, renamedPath);
  await renamed.click();
  await renamed.press(UNDO);
  await expect.poll(() => exists(aPath)).toBe(true);
  expect(await exists(renamedPath)).toBe(false);
  await expect(window.locator('header').first()).toContainText('a.ts', { timeout: 5_000 });
  await expect(a).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
  await expect(a).toBeFocused();

  await a.press(REDO);
  await expect.poll(() => exists(renamedPath)).toBe(true);
  expect(await exists(aPath)).toBe(false);
});

test('剪切粘贴移动后 ⌘Z:文件回到原目录并被选中', async ({ window, workspaceRoot }) => {
  const readmePath = path.join(workspaceRoot, 'README.md');
  const movedPath = path.join(workspaceRoot, 'src/README.md');
  const readme = rowOf(window, readmePath);
  await expect(readme).toBeVisible({ timeout: 10_000 });
  await readme.click();
  await readme.press('ControlOrMeta+x');
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await src.click();
  await src.press('ControlOrMeta+v');
  await expect.poll(() => exists(movedPath)).toBe(true);

  await src.press(UNDO);
  await expect.poll(() => exists(readmePath)).toBe(true);
  expect(await exists(movedPath)).toBe(false);
  await expect(readme).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
});

async function createFileInSrc(window: import('@playwright/test').Page, workspaceRoot: string, name: string) {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_NEW_FILE }).click();
  const input = window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
  await input.fill(name);
  await input.press('Enter');
  const p = path.join(workspaceRoot, 'src', name);
  await expect.poll(() => exists(p)).toBe(true);
  await expect(window.locator('header').first()).toContainText(name, { timeout: 10_000 });
  return p;
}

const TRASH_BUTTON = /^(移到废纸篓|Move to Trash|휴지통으로 이동)$/;

test('新建文件后回到树 ⌘Z:即使未改动也先确认(VSCode confirmUndo),焦点在「移到废纸篓」回车即移;⇧⌘Z 重新创建', async ({
  window,
  workspaceRoot,
  userDataDir,
}) => {
  const p = await createFileInSrc(window, workspaceRoot, 'hello.ts');
  const row = rowOf(window, p);
  await row.click();
  await row.press(UNDO);
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText('hello.ts');
  await expect(dialog.getByRole('button', { name: TRASH_BUTTON })).toBeFocused();
  expect(await exists(p)).toBe(true);
  await window.keyboard.press('Enter');
  await expect.poll(() => exists(p)).toBe(false);
  await expect(dialog).toHaveCount(0);
  // E2E 模式下移到 <userData>/e2e-trash,不进真实废纸篓
  expect(await exists(path.join(userDataDir, 'e2e-trash'))).toBe(true);

  await rowOf(window, path.join(workspaceRoot, 'src')).press(REDO);
  await expect.poll(() => exists(p)).toBe(true);
});

test('新建后文件被改过 → ⌘Z 同样先确认;取消则不删', async ({ window, workspaceRoot }) => {
  const p = await createFileInSrc(window, workspaceRoot, 'changed.ts');
  await writeFile(p, 'export const x = 1;\n');
  const row = rowOf(window, p);
  await row.click();
  await row.press(UNDO);
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText('changed.ts');
  await dialog.getByRole('button', { name: /^(取消|Cancel|취소)$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(await exists(p)).toBe(true);
});

test('撤销改名时原名已被外部占用:提示写被撤销的项与「此位置已存在「原名」」,不动磁盘', async ({
  window,
  workspaceRoot,
}) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const fivePath = path.join(workspaceRoot, 'src/five.ts');
  const a = rowOf(window, aPath);
  await a.click();
  await a.press('F2');
  const input = window.locator('[role=treeitem] input');
  await expect(input).toBeFocused({ timeout: 5_000 });
  await input.fill('five.ts');
  await input.press('Enter');
  await expect.poll(() => exists(fivePath)).toBe(true);

  await writeFile(aPath, 'external\n');
  const five = rowOf(window, fivePath);
  await five.click();
  await five.press(UNDO);
  const toast = window.locator('.toast[data-level="error"]');
  await expect(toast).toContainText(/[“「]five\.ts[”」]/, { timeout: 5_000 });
  await expect(toast).toContainText(
    /(此位置已存在「a\.ts」|A file or folder “a\.ts” already exists at this location|이 위치에 “a\.ts”이\(가\) 이미 있습니다)/,
  );
  expect(await exists(fivePath)).toBe(true);
});

test('撤销新建时文件有未保存的编辑器:确认框同删除确认给出未保存警告', async ({ window, workspaceRoot }) => {
  const p = await createFileInSrc(window, workspaceRoot, 'dirty.ts');
  await window.locator('.cm-content').first().click();
  await window.keyboard.type('let x = 1;');
  const row = rowOf(window, p);
  await row.click();
  await row.press(UNDO);
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText('dirty.ts');
  await expect(dialog).toContainText(
    /(该文件有未保存的更改|This file has unsaved changes|이 파일에 저장되지 않은 변경 내용이 있습니다)/,
  );
  await dialog.getByRole('button', { name: /^(取消|Cancel|취소)$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(await exists(p)).toBe(true);
});

test('复制粘贴后再删除另一个文件,⌘Z:被删文件按原内容回到原位(不确认);再 ⌘Z 才撤销复制(先确认)', async ({
  window,
  workspaceRoot,
}) => {
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const copyPath = path.join(workspaceRoot, 'src/a copy.ts');
  const a = rowOf(window, aPath);
  await a.click();
  await a.press('ControlOrMeta+c');
  await a.press('ControlOrMeta+v');
  await expect.poll(() => exists(copyPath)).toBe(true);

  const readmePath = path.join(workspaceRoot, 'README.md');
  const before = await readFile(readmePath);
  const readme = rowOf(window, readmePath);
  await readme.click();
  await readme.press('Delete');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText('README.md');
  await window.keyboard.press('Enter'); // 焦点在「移到废纸篓」
  await expect.poll(() => exists(readmePath)).toBe(false);

  const copy = rowOf(window, copyPath);
  await copy.click();
  await copy.press(UNDO);
  await expect.poll(() => exists(readmePath)).toBe(true);
  expect((await readFile(readmePath)).equals(before)).toBe(true);
  await expect(window.getByRole('alertdialog')).toHaveCount(0);
  await expect(readme).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
  expect(await exists(copyPath)).toBe(true);

  // 删除不再挡住更早的操作:再 ⌘Z 撤销复制(先确认)
  await readme.press(UNDO);
  const undoCopy = window.getByRole('alertdialog');
  await expect(undoCopy).toContainText('a copy.ts', { timeout: 5_000 });
  await undoCopy.getByRole('button', { name: TRASH_BUTTON }).click();
  await expect.poll(() => exists(copyPath)).toBe(false);
});

// 第五十六轮审计 A 组 #3:撤销删除符号链接 → 不重建,提示写明是符号链接(不是「文件过大或无法读取」)。
test('删除符号链接后 ⌘Z:不重建,提示「符号链接不能重建」', async ({ window, workspaceRoot }) => {
  test.skip(process.platform === 'win32', '建符号链接要权限');
  const linkPath = path.join(workspaceRoot, 'link.ts');
  await symlink(path.join(workspaceRoot, 'src/a.ts'), linkPath);
  // 链接行的 title 带链接目标,按可访问名称找
  const link = window.getByRole('treeitem', { name: 'link.ts', exact: true });
  await expect(link).toBeVisible({ timeout: 10_000 });
  await link.click();
  await link.press('Delete');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toContainText('link.ts');
  await window.keyboard.press('Enter');
  await expect.poll(() => lstat(linkPath).then(() => true, () => false)).toBe(false);
  const readme = rowOf(window, path.join(workspaceRoot, 'README.md'));
  await readme.click();
  await readme.press(UNDO);
  const toasts = window.locator('.toast__message');
  await expect(toasts.filter({ hasText: /link\.ts.*(符号链接不能重建|symbolic links can’t be recreated|심볼릭 링크)/ })).toHaveCount(1, { timeout: 5_000 });
  await expect(toasts.filter({ hasText: /文件过大或无法读取|too large or unreadable|너무 크거나/ })).toHaveCount(0);
  expect(await lstat(linkPath).then(() => true, () => false)).toBe(false);
  expect(await exists(path.join(workspaceRoot, 'src/a.ts'))).toBe(true);
});

// 保存遇磁盘冲突 →「放弃更改并重新加载」:tab 换成磁盘版本、不再脏,磁盘不被覆盖。单元规范见 src/__tests__/editor-revert-file/。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

const REVERT = /^(放弃更改并重新加载|Discard Changes and Reload|변경 내용 취소 후 다시 로드)$/;

test('改脏 a.ts → 外部改盘 → ⌘S 冲突 → 放弃更改并重新加载', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'src/a.ts');
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });

  const THEIRS = 'export const theirs = 1;\n';
  await writeFile(file, THEIRS);
  await window.keyboard.press('ControlOrMeta+s');
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: REVERT }).click();
  await expect(dialog).toBeHidden();

  await expect(cm).toContainText('export const theirs = 1;', { timeout: 5_000 });
  await expect(cm).not.toContainText('// mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);
  expect(await readFile(file, 'utf8')).toBe(THEIRS);
});

// 第五十五轮审计 B 组 #1:Markdown 编辑模式里还原文件 / 外部修改重载不重挂载,磁盘内容可撤销地套用(VSCode:⌘Z 找回)。
test.describe('Markdown 编辑模式', () => {
  test.beforeEach(async ({ window }) => {
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  });

  test('输入不保存 → 命令面板「还原文件」→ 内容回到磁盘版本,焦点仍在编辑区;⌘Z 找回输入', async ({ window, workspaceRoot }) => {
    await openWorkspaceFile(window, ['README.md']);
    await editorModeButton(window, EDITOR_MODE_EDIT).click();
    const heading = window.locator('main .milkdown h1');
    await expect(heading).toContainText('Test Workspace', { timeout: 10_000 });
    await heading.click();
    await window.keyboard.press('End');
    await window.keyboard.type(' mine');
    await expect(heading).toContainText('Test Workspace mine');
    await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR).first()).toBeVisible({ timeout: 5_000 });

    await openCommandPalette(window);
    const search = commandPaletteInput(window);
    await expect(search).toBeFocused({ timeout: 5_000 });
    await search.fill('Revert File');
    await window.keyboard.press('Enter');
    await expect(heading).not.toContainText('mine', { timeout: 5_000 });
    await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);
    // 不重挂载:焦点回到编辑区(而不是 BODY)
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.closest('.ProseMirror') !== null))
      .toBe(true);
    expect(await readFile(path.join(workspaceRoot, 'README.md'), 'utf8')).toBe('# Test Workspace\n');

    await window.keyboard.press('ControlOrMeta+z');
    await expect(heading).toContainText('Test Workspace mine', { timeout: 5_000 });
    await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR).first()).toBeVisible({ timeout: 5_000 });
  });

  test('干净文件被外部修改自动重载 → ⌘Z 回到重载前的内容(撤销历史不丢)', async ({ window, workspaceRoot }) => {
    const file = path.join(workspaceRoot, 'README.md');
    await openWorkspaceFile(window, ['README.md']);
    await editorModeButton(window, EDITOR_MODE_EDIT).click();
    const heading = window.locator('main .milkdown h1');
    await expect(heading).toContainText('Test Workspace', { timeout: 10_000 });
    await heading.click();
    await window.keyboard.press('End');
    await window.keyboard.type(' v2');
    await window.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(file, 'utf8')).toBe('# Test Workspace v2\n');
    await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);

    await writeFile(file, '# External\n');
    await expect(heading).toContainText('External', { timeout: 10_000 });
    await window.keyboard.press('ControlOrMeta+z');
    await expect(heading).toContainText('Test Workspace v2', { timeout: 5_000 });
  });
});

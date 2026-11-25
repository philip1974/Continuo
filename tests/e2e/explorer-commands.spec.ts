// 资源管理器入口命令:⌘⇧E 显示并聚焦资源管理器树(侧栏隐藏时打开);命令面板「新建文件」在树焦点项所在目录打开
// 新建输入框,创建后文件在编辑器打开。BDD: src/__tests__/explorer-commands/
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { commandPaletteInput, openCommandPalette, COMMAND_LIST } from './helpers/palette';

const NEW_FILE_NAME = /^(新建文件名…|New file name…|새 파일 이름…)$/;
const NEW_FILE_COMMAND = /(新建文件…|New File…|새 파일…)/;

test('⌘⇧E:编辑器里按下 → 焦点进资源管理器树;侧栏隐藏(⌘B)时先打开再聚焦', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeFocused({ timeout: 10_000 });

  await window.keyboard.press('ControlOrMeta+Shift+E');
  await expect(window.locator(':focus')).toHaveAttribute('role', 'treeitem');
  await expect(window.locator('aside[data-workbench-part="sidebar"] :focus')).toHaveCount(1);

  await cm.click();
  await window.keyboard.press('ControlOrMeta+B');
  await expect(window.locator('aside[data-workbench-part="sidebar"]')).toBeHidden();
  await window.keyboard.press('ControlOrMeta+Shift+E');
  await expect(window.locator('aside[data-workbench-part="sidebar"]')).toBeVisible();
  await expect(window.locator(':focus')).toHaveAttribute('role', 'treeitem');
});

test('命令面板「新建文件」:焦点在 src 行 → 在 src 下创建并打开,焦点进编辑器', async ({ window, workspaceRoot }) => {
  await window.locator('text=src').first().click();
  await expect(window.locator(':focus')).toHaveAttribute('role', 'treeitem');

  await openCommandPalette(window);
  const lang = await window.evaluate(() => document.documentElement.lang);
  await commandPaletteInput(window).fill(lang.startsWith('zh') ? '新建文件' : lang.startsWith('ko') ? '새 파일' : 'New File');
  const option = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: NEW_FILE_COMMAND })
    .first();
  await option.click();

  const input = window.getByRole('textbox', { name: NEW_FILE_NAME });
  await expect(input).toBeFocused({ timeout: 5_000 });
  await input.fill('from-cmd.ts');
  await input.press('Enter');

  await expect.poll(async () => (await readdir(path.join(workspaceRoot, 'src'))).sort()).toEqual([
    'a.ts',
    'b.ts',
    'from-cmd.ts',
  ]);
  await expect(window.locator('.cm-content')).toBeFocused({ timeout: 10_000 });
});

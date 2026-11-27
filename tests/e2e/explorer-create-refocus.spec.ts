// 资源管理器新建输入条(VSCode 行内输入框同款):失焦时有名字就创建、空名放弃;输入条开着时再新建 → 新输入条获焦,输入不落空。
// BDD: src/__tests__/explorer-tree/(新建一节)、src/__tests__/create-input/(失焦)
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FILE_PLACEHOLDER,
  EXPLORER_NEW_FOLDER,
  EXPLORER_NEW_FOLDER_PLACEHOLDER,
} from './helpers/explorer';
import { commandPaletteInput, openCommandPalette, COMMAND_LIST } from './helpers/palette';

const NEW_FOLDER_COMMAND = /(新建文件夹…|New Folder…|새 폴더…)/;

async function setup(window: Page) {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();
  const button = (name: RegExp) => aside.getByRole('button', { name });
  await expect(button(EXPLORER_NEW_FILE)).toBeVisible({ timeout: 10_000 });
  return { aside, button };
}

const fileInput = (window: Page) => window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
const folderInput = (window: Page) => window.getByRole('textbox', { name: EXPLORER_NEW_FOLDER_PLACEHOLDER });

test('新建文件输入条开着时点树里的项 → 空名放弃;再点「新建文件夹」→ 新输入条获焦,输入 + Enter 建出文件夹', async ({
  window,
  workspaceRoot,
}) => {
  const { aside, button } = await setup(window);
  await button(EXPLORER_NEW_FILE).click();
  await expect(fileInput(window)).toBeFocused();
  await aside.getByRole('treeitem', { name: /^src$/ }).click();
  await expect(fileInput(window)).toHaveCount(0);
  await aside.locator('div.group').first().hover();
  await button(EXPLORER_NEW_FOLDER).click();
  await expect(folderInput(window)).toBeFocused();
  await window.keyboard.type('made');
  await window.keyboard.press('Enter');
  await expect(async () => {
    expect((await stat(path.join(workspaceRoot, 'src', 'made'))).isDirectory()).toBe(true);
  }).toPass({ timeout: 5_000 });
});

test('有名字时点到编辑器 → 失焦即创建(同 Enter)', async ({ window, workspaceRoot }) => {
  const { aside, button } = await setup(window);
  await aside.getByRole('treeitem', { name: /^README\.md$/ }).dblclick();
  const editor = window.locator('main .cm-content, main .milkdown .ProseMirror').first();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await aside.locator('div.group').first().hover();
  await button(EXPLORER_NEW_FILE).click();
  await expect(fileInput(window)).toBeFocused();
  await window.keyboard.type('typed.ts');
  await editor.click();
  await expect(fileInput(window)).toHaveCount(0);
  await expect.poll(async () => (await readdir(workspaceRoot)).sort()).toContain('typed.ts');
});

test('输入条开着时经命令面板「新建文件夹…」→ 新输入条获焦,输入不落空', async ({ window, workspaceRoot }) => {
  const { button } = await setup(window);
  await button(EXPLORER_NEW_FILE).click();
  await expect(fileInput(window)).toBeFocused();
  await openCommandPalette(window);
  const lang = await window.evaluate(() => document.documentElement.lang);
  await commandPaletteInput(window).fill(lang.startsWith('zh') ? '新建文件夹' : lang.startsWith('ko') ? '새 폴더' : 'New Folder');
  await window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: NEW_FOLDER_COMMAND })
    .first()
    .click();
  await expect(folderInput(window)).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('via-cmd');
  await window.keyboard.press('Enter');
  await expect.poll(async () => (await readdir(workspaceRoot)).sort()).toContain('via-cmd');
});

// Quick Open 打开文件 / Explorer 新建文件后焦点进编辑器,可直接打字(VSCode 同款)。
// BDD: src/__tests__/editor-focus-on-open/
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { EXPLORER_NEW_FILE, EXPLORER_NEW_FILE_PLACEHOLDER } from './helpers/explorer';

test('已开 a.ts → Cmd+P 选 b.ts 回车 → 直接键入的文字进入 b.ts 编辑器', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });

  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await input.fill('b.ts');
  await expect(window.locator('.wm-modal-content li').first()).toContainText('b.ts', { timeout: 5_000 });
  await window.keyboard.press('Enter');

  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const b', { timeout: 10_000 });
  await expect(cm).toBeFocused();
  await window.keyboard.type('typed');
  await expect(cm).toContainText('typed');
});

test('Explorer 新建文件 → 打开后直接键入的文字进入新文件编辑器', async ({ window, workspaceRoot }) => {
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_NEW_FILE }).click();
  const createInput = window.getByRole('textbox', { name: EXPLORER_NEW_FILE_PLACEHOLDER });
  await expect(createInput).toBeVisible({ timeout: 5_000 });
  await createInput.fill('fresh.ts');
  await createInput.press('Enter');

  const cm = window.locator('.cm-content');
  await expect(cm).toBeFocused({ timeout: 10_000 });
  await window.keyboard.type('hello');
  await expect(cm).toContainText('hello');
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect(async () => {
    expect(await readFile(path.join(workspaceRoot, 'src/fresh.ts'), 'utf8')).toBe('hello');
  }).toPass({ timeout: 5_000 });
});

// Markdown 列表在 Preview / Edit(Milkdown)里可见,Edit 编辑后保存文件仍含列表。
// 回归:@milkdown/preset-commonmark 7.20 的 spread attr 类型不一致,列表节点整段被丢 —— Preview / Edit
// 看不到列表,在 Edit 里改一处再保存,文件里的列表全部消失(见 src/__tests__/editor-markdown-lists/README.md)。
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';

const DOC = ['# Lists', '', '- apple', '- banana', '  - nested', '', '1. first', '2. second', '', 'tail', ''].join('\n');

test('Preview:无序 / 有序 / 嵌套列表项可见', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'lists.md'), DOC);
  await openWorkspaceFile(window, ['lists.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();

  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('ul li').filter({ hasText: 'apple' })).toBeVisible({ timeout: 10_000 });
  await expect(pm.locator('ul li').filter({ hasText: 'nested' }).last()).toBeVisible();
  await expect(pm.locator('ol li').filter({ hasText: 'second' })).toBeVisible();
});

test('Edit:列表可见,编辑后保存文件仍含列表', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'lists.md');
  writeFileSync(file, DOC);
  await openWorkspaceFile(window, ['lists.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();

  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('ol li').filter({ hasText: 'first' })).toBeVisible({ timeout: 10_000 });

  await pm.locator('h1').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' edited');
  await window.keyboard.press('ControlOrMeta+KeyS');

  await expect(async () => {
    const content = await readFile(file, 'utf8');
    expect(content).toContain('edited');
    expect(content).toMatch(/^[*-] apple$/m);
    expect(content).toMatch(/^ {2}[*-] nested$/m);
    expect(content).toMatch(/^2\. second$/m);
  }).toPass({ timeout: 5_000 });
});

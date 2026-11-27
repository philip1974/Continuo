// Markdown 编辑模式(Milkdown)的写作行为(第四十七轮审计 B4 / B7 / B9):
//  - 改一处保存,文件只变那一行(序列化风格跟随原文件);
//  - 选中文字粘贴 URL 成链接;⌘K / Ctrl+K 打开链接框给选区加链接;
//  - 表格最后一格 Tab 新起一行(不在格内插空格)。
// 见 src/__tests__/editor-milkdown-roundtrip-style/、src/__tests__/editor-markdown-writing-keys/。
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';

const PM = 'main .milkdown .ProseMirror';

async function openInEdit(window: Page, workspaceRoot: string, name: string, content: string): Promise<string> {
  const file = path.join(workspaceRoot, name);
  writeFileSync(file, content);
  await openWorkspaceFile(window, [name]);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  await expect(window.locator(PM)).toBeVisible({ timeout: 10_000 });
  return file;
}

/** 在编辑区里用 DOM 选区选中第一处 `word`(ProseMirror 经 selectionchange 读回)。 */
async function selectWord(window: Page, word: string): Promise<void> {
  await window.locator(PM).getByText(word).first().click();
  await window.evaluate(
    ({ sel, w }) => {
      const pm = document.querySelector(sel)!;
      const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(w);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + w.length);
        const s = document.getSelection()!;
        s.removeAllRanges();
        s.addRange(range);
        return;
      }
      throw new Error(`找不到 ${w}`);
    },
    { sel: PM, w: word },
  );
  await expect.poll(() => window.evaluate(() => document.getSelection()?.toString())).toBe(word);
}

async function save(window: Page): Promise<void> {
  await window.keyboard.press('ControlOrMeta+KeyS');
}

const DOC = [
  '# Writing',
  '',
  'Intro with *emphasis*, **strong**, `code`, [link](https://example.com), 2 * 3 and snake_case_name.',
  '',
  '- [ ] task one',
  '- [x] task two',
  '',
  'Code below is indented (after a paragraph, not a list continuation):',
  '',
  '    indented code',
  '',
  '| Name | Value |',
  '| ---- | ----- |',
  '| a    | 1     |',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
  '',
  'Tail paragraph.',
  '',
].join('\n');

test('编辑模式改一处保存:文件只变那一行', async ({ window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'writing.md', DOC);
  await window.locator(PM).getByText('task one').click();
  await window.keyboard.press('End');
  await window.keyboard.type('!');
  await save(window);
  await expect(async () => {
    const after = (await readFile(file, 'utf8')).split('\n');
    const before = DOC.split('\n');
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [`${i + 1}: ${line}`]));
    expect(changed).toEqual(['5: - [ ] task one!']);
    expect(after.length).toBe(before.length);
  }).toPass({ timeout: 5_000 });
});

test('选中文字后粘贴 URL → 选区成链接', async ({ electronApp, window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'paste.md', 'See the documentation please\n');
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('https://example.com/docs'));
  await selectWord(window, 'documentation');
  await window.keyboard.press('ControlOrMeta+KeyV');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('See the [documentation](https://example.com/docs) please\n');
  }).toPass({ timeout: 5_000 });
});

test('⌘K / Ctrl+K 打开链接框,确认后选区成链接', async ({ window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'cmdk.md', 'Read the guide now\n');
  await selectWord(window, 'guide');
  await window.keyboard.press('ControlOrMeta+KeyK');
  const input = window.locator('.milkdown-link-edit[data-show="true"] input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill('https://example.com/guide');
  await input.press('Enter');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('Read the [guide](https://example.com/guide) now\n');
  }).toPass({ timeout: 5_000 });
});

test('表格最后一格 Tab → 新起一行并进入其首格', async ({ window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'table.md', '| a | b |\n| - | - |\n| c | d |\n');
  await window.locator(`${PM} td`).filter({ hasText: /^d$/ }).click();
  await window.keyboard.press('End');
  await window.keyboard.press('Tab');
  await window.keyboard.type('X');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('| a | b |\n| - | - |\n| c | d |\n| X |   |\n');
  }).toPass({ timeout: 5_000 });
});

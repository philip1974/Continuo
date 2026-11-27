// Markdown 编辑模式(Milkdown)的写作行为(第四十七轮审计 B4 / B7 / B9、第四十八轮审计 A2–A6):
//  - 改一处保存,文件只变那一行(未改动的块原样写回,序列化风格跟随原文件);CRLF / UTF-16 LE CRLF 的行尾与编码保持;
//  - 选中文字粘贴 URL 成链接;⌘K / Ctrl+K 打开链接框给选区加链接;之后接着打字不替换链接文字;
//  - 表格最后一格 Tab 新起一行(不在格内插空格)。
// 见 src/__tests__/editor-milkdown-roundtrip-style/、src/__tests__/editor-milkdown-roundtrip-verbatim/、
// src/__tests__/editor-markdown-writing-keys/。
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';

const PM = 'main .milkdown .ProseMirror';

async function openInEdit(window: Page, workspaceRoot: string, name: string, content: string | Buffer): Promise<string> {
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

// 审计列出的常见写法(均不是 remark-stringify 的写法)+ 文末多余空行
const STYLES_DOC = [
  '# Styles',
  '',
  'Bare link https://b.com. and [x] in text, `$HOME` then $PATH.',
  '',
  'Hard break  ',
  'next line',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '|left|right|',
  '|:----:|------:|',
  '|1|2|',
  '',
  'x | y',
  '--|--',
  'p | q',
  '',
  '1. one',
  '1. two',
  '1. three',
  '',
  'Final paragraph.',
  '',
  '',
  '',
].join('\n');

/** 逐行比较(按 \n 切,CR 留在行里),返回改动的行。 */
function changedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) out.push(`${i + 1}: ${JSON.stringify(b[i])}`);
  return out;
}

async function typeAtEndOf(window: Page, text: string, typed: string): Promise<void> {
  await window.locator(PM).getByText(text).first().click();
  await window.keyboard.press('End');
  await window.keyboard.type(typed);
}

test('常见写法(表格 / 裸链接 / 硬换行 / `1. 1. 1.` / `[x]` / 文末空行)的文档改一字:文件只变那一行', async ({
  window,
  workspaceRoot,
}) => {
  const file = await openInEdit(window, workspaceRoot, 'styles.md', STYLES_DOC);
  await typeAtEndOf(window, 'Final paragraph.', '!');
  await save(window);
  await expect(async () => {
    expect(changedLines(STYLES_DOC, await readFile(file, 'utf8'))).toEqual(['28: "Final paragraph.!"']);
  }).toPass({ timeout: 5_000 });
  // 再改裸链接所在的段:该段其余写法也保持
  await typeAtEndOf(window, 'then', '!');
  await save(window);
  await expect(async () => {
    expect(changedLines(STYLES_DOC, await readFile(file, 'utf8'))).toEqual([
      '3: "Bare link https://b.com. and [x] in text, `$HOME` then $PATH.!"',
      '28: "Final paragraph.!"',
    ]);
  }).toPass({ timeout: 5_000 });
});

test('裸链接 + 含 `$` 的行内代码 + 硬换行的段落里打一个字:文件只多那一个字(行内代码不被改写成别的样子)', async ({
  window,
  workspaceRoot,
}) => {
  // `$PATH `$` 按 Pandoc 规则是公式(吞掉一个反引号),其后的反引号错配成跨行的行内代码;曾经改一字整段被 remark 改写(第五十轮)
  const doc = 'Bare https://b.com/p. `$HOME` then $PATH `$HOME` then $PATH  \n[delta](https://ex.com/5) $5 and $10 `alpha`\n\nTail.\n';
  const file = await openInEdit(window, workspaceRoot, 'combo.md', doc);
  await window.locator(PM).getByText('Tail.').click();
  // 光标放到第一处「then」之后(DOM 选区,ProseMirror 经 selectionchange 读回)
  await window.evaluate((sel) => {
    const walker = document.createTreeWalker(document.querySelector(sel)!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf('then');
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i + 4);
      const s = document.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      return;
    }
    throw new Error('找不到 then');
  }, PM);
  await expect.poll(() => window.evaluate(() => document.getSelection()?.anchorNode?.textContent ?? '')).toContain('then');
  await window.keyboard.type('q');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe(doc.replace('then', 'thenq'));
  }).toPass({ timeout: 5_000 });
});

const footer = (window: Page) => window.locator('footer');
const eolItem = (window: Page) => footer(window).locator('[data-statusbar-eol]');
const LE_BOM = Buffer.from([0xff, 0xfe]);

test('CRLF 与 UTF-16 LE CRLF 的 .md 编辑模式保存:行尾 / 编码不变,只变那一行', async ({ window, workspaceRoot }) => {
  const crlf = STYLES_DOC.replace(/\n/g, '\r\n');
  const a = await openInEdit(window, workspaceRoot, 'crlf.md', crlf);
  await expect(eolItem(window)).toHaveText('CRLF');
  await typeAtEndOf(window, 'Final paragraph.', '!');
  await save(window);
  await expect(async () => {
    const after = await readFile(a, 'utf8');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(changedLines(crlf, after)).toEqual(['28: "Final paragraph.!\\r"']);
  }).toPass({ timeout: 5_000 });
  await expect(eolItem(window)).toHaveText('CRLF');

  const utf16 = '# T\r\n\r\n|a|b|\r\n|-|-|\r\n|1|2|\r\n\r\nbody\r\n';
  const b = await openInEdit(window, workspaceRoot, 'utf16.md', Buffer.concat([LE_BOM, Buffer.from(utf16, 'utf16le')]));
  await typeAtEndOf(window, 'body', '!');
  await save(window);
  await expect
    .poll(async () => [...(await readFile(b))], { timeout: 5_000 })
    .toEqual([...LE_BOM, ...Buffer.from(utf16.replace('body', 'body!'), 'utf16le')]);
  await expect(eolItem(window)).toHaveText('CRLF');
});

test('编辑模式下用状态栏把行尾改成 CRLF:之后的编辑保存按 CRLF 写', async ({ window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'eol.md', '# T\n\n|a|b|\n|-|-|\n|1|2|\n\nbody\n');
  await eolItem(window).click();
  await window.locator('.wm-modal-content [data-encoding-pick="CRLF"]').click();
  await expect(eolItem(window)).toHaveText('CRLF');
  await typeAtEndOf(window, 'body', '!');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('# T\r\n\r\n|a|b|\r\n|-|-|\r\n|1|2|\r\n\r\nbody!\r\n');
  }).toPass({ timeout: 5_000 });
  await expect(eolItem(window)).toHaveText('CRLF');
});

test('选中文字后粘贴 URL → 选区成链接', async ({ electronApp, window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'paste.md', 'See the documentation please\n');
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('https://example.com/docs'));
  await selectWord(window, 'documentation');
  await window.keyboard.press('ControlOrMeta+KeyV');
  // 光标收到链接末尾:接着打字不替换链接文字、也不并进链接
  await window.keyboard.type('X');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('See the [documentation](https://example.com/docs)X please\n');
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
  // 链接框收起、焦点回到正文后接着打字:不替换链接文字、不并进链接
  await expect(input).toBeHidden({ timeout: 5_000 });
  await expect.poll(() => window.evaluate((sel) => document.querySelector(sel)?.contains(document.activeElement), PM)).toBe(true);
  await window.keyboard.type('X');
  await save(window);
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('Read the [guide](https://example.com/guide)X now\n');
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

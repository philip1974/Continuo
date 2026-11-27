// Markdown 编辑模式里编辑裸链接(第五十一轮审计 A2 / A3 / A4,BDD: src/__tests__/editor-markdown-autolink-edit/):
//  - A2:裸链接后接全角标点「。」「，」→ 链接同 GFM 认定,保存原样(不转义成 `https\://…`、`www\.…`)
//  - A4:续写 `.cn` / `?q=1`(逐键,先打的 `.` / `?` 一度是句末标点)→ 地址跟随整段,保存仍是裸链接(不变成 `<url>.cn`)
//  - A3:输入法在链接末尾组字「中文」(CDP Input.imeSetComposition + Input.insertText)→ 组字结束后地址跟随,保存为裸链接
//   (不写成 `[https://example.com中文](https://example.com)`)
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

/** 光标放到第一个链接文字末尾(DOM 选区,ProseMirror 经 selectionchange 读回)。 */
async function caretAtLinkEnd(window: Page): Promise<void> {
  await window.locator(PM).getByText('Tail.').click();
  await window.evaluate((sel) => {
    const a = document.querySelector(`${sel} a`)!;
    const text = a.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    const s = document.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
  }, PM);
  await expect.poll(() => window.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.tagName)).toBe('A');
}

async function saveAndExpect(window: Page, file: string, expected: string): Promise<void> {
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe(expected);
  }).toPass({ timeout: 5_000 });
}

test('裸链接后接全角「。」/「，」、www. 后接「。」:保存原样,不转义', async ({ window, workspaceRoot }) => {
  for (const [name, url, punct] of [
    ['full-stop.md', 'https://example.com', '。'],
    ['comma.md', 'https://example.com', '，'],
    ['www.md', 'www.example.com', '。'],
  ] as const) {
    const doc = `Para with ${url} bare.\n\nTail.\n`;
    const file = await openInEdit(window, workspaceRoot, name, doc);
    await caretAtLinkEnd(window);
    await window.keyboard.type(punct);
    await saveAndExpect(window, file, doc.replace(url, url + punct));
  }
});

test('续写 `.cn` / `?q=1`:地址跟随整段,保存仍是裸链接', async ({ window, workspaceRoot }) => {
  const doc = 'Para with https://example.com bare.\n\nTail.\n';
  const a = await openInEdit(window, workspaceRoot, 'cn.md', doc);
  await caretAtLinkEnd(window);
  await window.keyboard.type('.cn');
  await expect(window.locator(`${PM} a`).first()).toHaveAttribute('href', 'https://example.com.cn');
  await saveAndExpect(window, a, doc.replace('https://example.com', 'https://example.com.cn'));

  const b = await openInEdit(window, workspaceRoot, 'query.md', doc);
  await caretAtLinkEnd(window);
  await window.keyboard.type('/p?q=1');
  await expect(window.locator(`${PM} a`).first()).toHaveAttribute('href', 'https://example.com/p?q=1');
  await saveAndExpect(window, b, doc.replace('https://example.com', 'https://example.com/p?q=1'));
});

test('输入法在链接末尾组字「中文」:组字结束后地址跟随,保存为裸链接', async ({ window, workspaceRoot }) => {
  const doc = 'Para with https://example.com bare.\n\nTail.\n';
  const file = await openInEdit(window, workspaceRoot, 'ime.md', doc);
  await caretAtLinkEnd(window);
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  await cdp.send('Input.insertText', { text: '中文' });
  await expect(window.locator(`${PM} a`).first()).toHaveAttribute('href', 'https://example.com中文', { timeout: 5_000 });
  await saveAndExpect(window, file, doc.replace('https://example.com', 'https://example.com中文'));
});

// 第五十二轮审计 A1:普通文字随输入成了网址 / www. / 邮箱 → 成为链接,保存原样(不再插反斜杠 `https\://` / `www\.` / `a\@`)
test('新打的网址 / www. / 邮箱、`https//…` 补 `:`:成为链接,保存原样', async ({ window, workspaceRoot }) => {
  for (const [name, typed, href] of [
    ['url.md', ' see https://example.com done', 'https://example.com'],
    ['www-new.md', ' www.example.com ok', 'http://www.example.com'],
    ['mail.md', ' mail a@example.com ok', 'mailto:a@example.com'],
  ] as const) {
    const doc = 'Start here\n\nTail.\n';
    const file = await openInEdit(window, workspaceRoot, name, doc);
    await window.locator(PM).getByText('Start here').click();
    await window.keyboard.press('End');
    await window.keyboard.type(typed);
    await expect(window.locator(`${PM} a`).first()).toHaveAttribute('href', href);
    await saveAndExpect(window, file, `Start here${typed}\n\nTail.\n`);
  }
  const doc = 'Go https//example.com now\n\nTail.\n';
  const file = await openInEdit(window, workspaceRoot, 'colon.md', doc);
  await window.locator(PM).getByText('Go https//example.com now').click();
  await window.keyboard.press('Home');
  for (let i = 0; i < 'Go https'.length; i += 1) await window.keyboard.press('ArrowRight');
  await window.keyboard.type(':');
  await expect(window.locator(`${PM} a`).first()).toHaveAttribute('href', 'https://example.com');
  await saveAndExpect(window, file, 'Go https://example.com now\n\nTail.\n');
});

// 第五十二轮审计 A2:在空格前回车拆段 → 新段段首空白去掉,保存不出现 `&#x20;`
test('空格前回车拆段:新段不以空格开头,保存不出现 `&#x20;`', async ({ window, workspaceRoot }) => {
  const file = await openInEdit(window, workspaceRoot, 'split.md', 'Para with *em* BETA tail\n\nTail.\n');
  await window.locator(PM).getByText('Tail.').click();
  // 光标放在 `BETA` 后、空格前(DOM 选区,ProseMirror 经 selectionchange 读回)
  await window.evaluate((sel) => {
    const walker = document.createTreeWalker(document.querySelector(sel)!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(' tail');
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      const s = document.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      return;
    }
  }, PM);
  await expect.poll(() => window.evaluate(() => document.getSelection()?.anchorNode?.textContent?.slice(document.getSelection()!.anchorOffset))).toBe(' tail');
  await window.keyboard.press('Enter');
  await expect(window.locator(`${PM} p`).nth(1)).toHaveText('tail');
  await saveAndExpect(window, file, 'Para with *em* BETA\n\ntail\n\nTail.\n');
});

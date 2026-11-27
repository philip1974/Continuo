// Markdown 锚点链接:`#标题`(同文档)与 `./sub/other.md#section`(跨文件)在编辑 / 预览 / 源码三种模式都定位到标题;
// 中文 / 重复标题的 id 与片段同一套 GitHub slug;⌃-(后退)回到跳转前的位置。BDD: src/__tests__/markdown-anchor-links/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isMac = process.platform === 'darwin';
const BACK = isMac ? 'Control+Minus' : 'Alt+ArrowLeft';
const MOD = isMac ? 'Meta' : 'Control';

const LINKS = '[Section 50](#section-50) · [中文](#安装-指南) · [dup](#faq-1) · [other](./sub/other.md#section-b)';
const DOC = [
  LINKS,
  ...Array.from({ length: 60 }, (_, i) => ['', `## Section ${i + 1}`, '', `text ${i + 1}`]).flat(),
  '',
  '## 安装 指南',
  '',
  'zh body',
  '',
  '## FAQ',
  '',
  'first faq',
  '',
  '## FAQ',
  '',
  'second faq',
  '',
].join('\n');
const OTHER = ['# Other', '', ...Array.from({ length: 120 }, (_, i) => `filler ${i + 1}\n`), '## Section B', '', 'b body', ''].join('\n');

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui128c-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui128c-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'doc.md'), DOC);
  mkdirSync(path.join(ws, 'sub'));
  writeFileSync(path.join(ws, 'sub', 'other.md'), OTHER);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await openWorkspaceFile(win, ['doc.md']);
  return win;
}

const heading = (win: Page, id: string) => win.locator(`main .milkdown :is(h1,h2)[id="${id}"]`);
const link = (win: Page, text: string) => win.locator('main .milkdown a', { hasText: text });

/** 编辑 / 预览:点链接(编辑模式带 Cmd/Ctrl)。 */
async function clickMilkdownLink(win: Page, text: string, withModifier: boolean): Promise<void> {
  const a = link(win, text);
  await expect(a).toBeVisible({ timeout: 10_000 });
  await a.click(withModifier ? { modifiers: ['ControlOrMeta'] } : {});
}

for (const mode of ['preview', 'edit'] as const) {
  test(`${mode}:同文档锚点滚到标题(中文 / 重复标题),⌃- 回到链接处`, async () => {
    test.setTimeout(90_000);
    const win = await launch();
    await editorModeButton(win, mode === 'preview' ? EDITOR_MODE_PREVIEW : EDITOR_MODE_EDIT).click();
    const withModifier = mode === 'edit';
    // 渲染出的标题 id 用同一套 slug
    await expect(heading(win, 'section-50')).toHaveCount(1, { timeout: 10_000 });
    await expect(heading(win, '安装-指南')).toHaveCount(1);
    await expect(heading(win, 'faq')).toHaveCount(1);
    await expect(heading(win, 'faq-1')).toHaveCount(1);

    await clickMilkdownLink(win, 'Section 50', withModifier);
    await expect(heading(win, 'section-50')).toBeInViewport();
    await expect(link(win, 'Section 50')).not.toBeInViewport();
    await win.keyboard.press(BACK);
    await expect(link(win, 'Section 50')).toBeInViewport();
    await expect(heading(win, 'section-50')).not.toBeInViewport();

    await clickMilkdownLink(win, '中文', withModifier);
    await expect(heading(win, '安装-指南')).toBeInViewport();
    await win.keyboard.press(BACK);
    await expect(link(win, 'dup')).toBeInViewport();
    await clickMilkdownLink(win, 'dup', withModifier);
    await expect(win.locator('main .milkdown p', { hasText: 'second faq' })).toBeInViewport();
  });
}

test('preview:跨文件 ./sub/other.md#section-b 打开后滚到标题,⌃- 回到 doc.md 链接处', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await editorModeButton(win, EDITOR_MODE_PREVIEW).click();
  await clickMilkdownLink(win, 'other', false);
  await expect(win.locator('header').first()).toContainText('other.md', { timeout: 10_000 });
  await expect(heading(win, 'section-b')).toBeInViewport({ timeout: 10_000 });
  await win.keyboard.press(BACK);
  await expect(win.locator('header').first()).toContainText('doc.md', { timeout: 10_000 });
  await expect(link(win, 'Section 50')).toBeInViewport({ timeout: 10_000 });
});

/** 源码模式:Cmd/Ctrl+click 第 1 行里 needle 所在的字符。 */
async function cmdClickSource(win: Page, needle: string): Promise<void> {
  const line = win.locator('.cm-line').first();
  await expect(line).toContainText(needle, { timeout: 10_000 });
  const box = await line.evaluate((el, text) => {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(text);
      if (i < 0) continue;
      const r = el.ownerDocument.createRange();
      r.setStart(n, i + 1);
      r.setEnd(n, i + 2);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, needle);
  expect(box).not.toBeNull();
  await win.keyboard.down(MOD);
  await win.mouse.click(box!.x, box!.y);
  await win.keyboard.up(MOD);
}

test('source:Cmd/Ctrl+click 同文档锚点光标到标题行、跨文件锚点到 other.md 的标题行;⌃- 回到原处;不添加多光标', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await editorModeButton(win, EDITOR_MODE_SOURCE).click();
  await expect(win.locator('.cm-content')).toContainText('[Section 50]', { timeout: 10_000 });

  await cmdClickSource(win, '#section-50');
  await expect(win.locator('.cm-activeLine')).toHaveText('## Section 50');
  await expect(win.locator('.cm-cursor')).toHaveCount(1); // Cmd+click 未被当成「添加光标」
  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-activeLine')).toContainText('[Section 50]');

  await cmdClickSource(win, '#安装-指南');
  await expect(win.locator('.cm-activeLine')).toHaveText('## 安装 指南');
  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-activeLine')).toContainText('[Section 50]');

  await cmdClickSource(win, 'other.md#section-b');
  await expect(win.locator('header').first()).toContainText('other.md', { timeout: 10_000 });
  await expect(win.locator('.cm-activeLine')).toHaveText('## Section B');
  await win.keyboard.press(BACK);
  await expect(win.locator('header').first()).toContainText('doc.md', { timeout: 10_000 });
  await expect(win.locator('.cm-activeLine')).toContainText('[Section 50]');
});

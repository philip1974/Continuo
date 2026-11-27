// 从 Finder 拖磁盘文件进来(BDD: src/__tests__/os-file-drop/):不按 ⇧ → 打开被拖文件、当前文档不变(修前:代码编辑器 / Markdown 源码
// 把文件**内容**插到文档开头,编辑视图 / png / 编辑区以外什么都不发生);⇧ → 插入路径 / 链接。
// 真实 Finder 拖放 Playwright 驱动不了:<input type=file> 取得带磁盘路径的 File,构造 DataTransfer 派发 drop(同 markdown-image-paste)。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_MODE_SOURCE, EDITOR_TABS, editorModeButton, openWorkspaceFile } from './helpers/editor';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
  'hex',
);

let outside = '';
test.beforeEach(() => {
  outside = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-finder-'));
  writeFileSync(path.join(outside, 'notes.txt'), 'NOTES FILE CONTENT\n');
  writeFileSync(path.join(outside, 'other.txt'), 'OTHER FILE CONTENT\n');
  writeFileSync(path.join(outside, 'pic.png'), PNG);
});
test.afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

const groups = (window: Page) => window.locator('[data-editor-panel-root]');
const tabNames = (window: Page) =>
  groups(window)
    .nth(0)
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop()));
const activeTabName = (window: Page) =>
  groups(window)
    .nth(0)
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab', { selected: true })
    .getAttribute('title')
    .then((t) => t?.split(/[\\/]/).pop());

/** 模拟从 Finder 把 files(磁盘路径)拖到 target 上放下。 */
async function finderDrop(window: Page, target: Locator, files: string[], opts: { shiftKey?: boolean } = {}): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'e2e-finder-drop';
    input.style.display = 'none';
    document.body.append(input);
  });
  await window.locator('#e2e-finder-drop').setInputFiles(files);
  const box = (await target.boundingBox())!;
  await target.evaluate(
    (el, at) => {
      const input = document.getElementById('e2e-finder-drop') as HTMLInputElement;
      const dt = new DataTransfer();
      for (const f of Array.from(input.files!)) dt.items.add(f);
      input.remove();
      const init = { dataTransfer: dt, clientX: at.x, clientY: at.y, shiftKey: at.shiftKey, bubbles: true, cancelable: true };
      el.dispatchEvent(new DragEvent('dragover', init));
      el.dispatchEvent(new DragEvent('drop', init));
    },
    { x: box.x + Math.min(40, box.width / 2), y: box.y + Math.min(20, box.height / 2), shiftKey: opts.shiftKey ?? false },
  );
}

test('代码编辑器:拖入 txt / png / 多个文件 → 全部打开(png 为图片预览),当前文档不变;⇧ 拖入 → 插入路径、不打开', async ({
  window,
  workspaceRoot,
}) => {
  const a = path.join(workspaceRoot, 'src/a.ts');
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const cm = window.locator('main .cm-content').first();
  await expect(cm).toContainText('export const a = 1;');

  await finderDrop(window, cm, [path.join(outside, 'notes.txt')]);
  await expect.poll(() => tabNames(window)).toEqual(['a.ts', 'notes.txt']);
  await expect.poll(() => activeTabName(window)).toBe('notes.txt');
  await expect(window.locator('main .cm-content').first()).toContainText('NOTES FILE CONTENT');

  // 回到 a.ts:内容没被插入任何东西、不脏
  await groups(window).getByRole('tab', { name: /a\.ts/ }).first().click();
  await expect(cm).toHaveText('export const a = 1;');
  expect(readFileSync(a, 'utf8')).toBe('export const a = 1;\n');

  await finderDrop(window, window.locator('main .cm-content').first(), [path.join(outside, 'pic.png')]);
  await expect.poll(() => activeTabName(window)).toBe('pic.png');
  await expect(groups(window).locator('img').first()).toBeVisible({ timeout: 10_000 });

  await groups(window).getByRole('tab', { name: /a\.ts/ }).first().click();
  await finderDrop(window, window.locator('main .cm-content').first(), [path.join(outside, 'other.txt'), path.join(outside, 'notes.txt')]);
  await expect.poll(() => tabNames(window)).toEqual(['a.ts', 'notes.txt', 'pic.png', 'other.txt']);
  await expect.poll(() => activeTabName(window)).toBe('other.txt');

  await groups(window).getByRole('tab', { name: /a\.ts/ }).first().click();
  await finderDrop(window, window.locator('main .cm-content').first(), [path.join(outside, 'notes.txt')], { shiftKey: true });
  await expect(window.locator('main .cm-content').first()).toContainText(path.join(outside, 'notes.txt'));
  await expect.poll(() => activeTabName(window)).toBe('a.ts');
  expect(await tabNames(window)).toEqual(['a.ts', 'notes.txt', 'pic.png', 'other.txt']);
});

test('Markdown 源码 / 编辑视图:拖入 txt → 打开、文档不变;源码视图 ⇧ → 插入相对文档的链接', async ({ window, workspaceRoot }) => {
  const md = path.join(workspaceRoot, 'README.md');
  await openWorkspaceFile(window, ['README.md']);

  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  const cm = window.locator('main .cm-content').first();
  await expect(cm).toContainText('# Test Workspace');
  await finderDrop(window, cm, [path.join(outside, 'notes.txt')]);
  await expect.poll(() => activeTabName(window)).toBe('notes.txt');
  expect(readFileSync(md, 'utf8')).toBe('# Test Workspace\n');

  await groups(window).getByRole('tab', { name: /README\.md/ }).first().click();
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror').first();
  await expect(pm).toContainText('Test Workspace', { timeout: 10_000 });
  await finderDrop(window, pm, [path.join(outside, 'other.txt')]);
  await expect.poll(() => activeTabName(window)).toBe('other.txt');
  expect(readFileSync(md, 'utf8')).toBe('# Test Workspace\n');

  await groups(window).getByRole('tab', { name: /README\.md/ }).first().click();
  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  await expect(cm).toContainText('# Test Workspace');
  await finderDrop(window, window.locator('main .cm-content').first(), [path.join(outside, 'notes.txt')], { shiftKey: true });
  const rel = path.relative(workspaceRoot, path.join(outside, 'notes.txt')).split(path.sep).join('/');
  await expect(window.locator('main .cm-content').first()).toContainText(`[text](${rel})`);
  await expect.poll(() => activeTabName(window)).toBe('README.md');
});

test('拖到编辑区以外(状态栏)→ 在编辑器里打开全部文件', async ({ window }) => {
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const statusBar = window.locator('footer[data-statusbar]');
  await expect(statusBar).toBeVisible();
  await finderDrop(window, statusBar, [path.join(outside, 'notes.txt'), path.join(outside, 'other.txt')]);
  await expect.poll(() => tabNames(window)).toEqual(['a.ts', 'notes.txt', 'other.txt']);
  await expect.poll(() => activeTabName(window)).toBe('notes.txt');
});

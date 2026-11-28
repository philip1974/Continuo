// 编辑器剪贴板(第六十三轮 B 组审计):无选区 ⌘C 复制整行带换行 + 编辑器元数据(换了渲染进程状态仍整行插到上方)、复制带语法
// 高亮的 HTML、粘贴后紧接着输入不合成一次撤销;复制路径 ⌥⌘C 在资源管理器生效、编辑器里不生效;Markdown 编辑模式粘贴网页 HTML
// 的图片 title / 代码块语言。见 src/__tests__/editor-clipboard/、src/__tests__/explorer-commands/(第 6 条)。
// 系统剪贴板经 main 进程 Electron clipboard 读写;每个断言前先写入已知值。
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { explorerTreeItem } from './helpers/explorer';

test.skip(process.platform !== 'darwin', '键位按 mac 写(⌘ / ⌥⌘C)');

const CM = 'main .cm-content';

async function cmText(window: Page): Promise<string> {
  return window.evaluate((sel) => {
    const lines = [...document.querySelectorAll(`${sel} .cm-line`)].map((l) => l.textContent ?? '');
    return lines.join('\n');
  }, CM);
}

/** 光标放到第 line 行(1 起)第 col 列(0 起),无选区。 */
async function caret(window: Page, line: number, col: number): Promise<void> {
  await window.locator(CM).click();
  await window.keyboard.press('Meta+ArrowUp');
  for (let i = 1; i < line; i++) await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Meta+ArrowLeft');
  for (let i = 0; i < col; i++) await window.keyboard.press('ArrowRight');
}

test('无选区 ⌘C:整行带换行 + 高亮 HTML + 元数据;重载后(新的渲染进程状态)粘贴仍整行插到上方;粘贴与随后输入分开撤销', async ({
  electronApp,
  window,
}) => {
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await expect(window.locator(CM)).toContainText('export const a = 1;', { timeout: 10_000 });
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'));
  await caret(window, 1, 3);
  await window.keyboard.press('Meta+KeyC');
  await expect.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('export const a = 1;\n');
  const { html, types } = await electronApp.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    const item = items[0]!;
    return { html: item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '', types: item.types };
  });
  expect(html).toContain('white-space: pre;');
  expect(html).toMatch(/<span style="color: rgb\([^)]*\);">export<\/span>/);
  // 编辑器元数据走 Chromium 的 Web 自定义数据格式(在系统剪贴板里,跨渲染进程可读)
  expect(types.some((f) => f.includes('web-custom-data'))).toBe(true);
  // 重载:CodeMirror 的模块级 lastLinewiseCopy 清空,只剩系统剪贴板里的元数据(同另一个窗口粘贴)
  await window.reload();
  await window.waitForLoadState('domcontentloaded');
  await openWorkspaceFile(window, ['src', 'b.ts']);
  await expect(window.locator(CM)).toContainText('export const b = 2;', { timeout: 10_000 });
  await caret(window, 1, 6);
  await window.keyboard.press('Meta+KeyV');
  await window.keyboard.type('X');
  await expect.poll(() => cmText(window)).toBe('export const a = 1;\nexportX const b = 2;\n');
  // 撤销一次只撤掉粘贴后的输入,再撤销撤掉粘贴
  await window.keyboard.press('Meta+KeyZ');
  await expect.poll(() => cmText(window)).toBe('export const a = 1;\nexport const b = 2;\n');
  await window.keyboard.press('Meta+KeyZ');
  await expect.poll(() => cmText(window)).toBe('export const b = 2;\n');

  // 外部复制的一行(无元数据)→ 插在光标处
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('ext\n'));
  await caret(window, 1, 6);
  await window.keyboard.press('Meta+KeyV');
  await expect.poll(() => cmText(window)).toBe('exportext\n const b = 2;\n');
});

test('⌥⌘C / ⇧⌥⌘C:资源管理器获焦复制焦点项路径;编辑器获焦不复制', async ({ electronApp, window, workspaceRoot }) => {
  const readme = explorerTreeItem(window, /^README\.md$/);
  await expect(readme).toBeVisible({ timeout: 10_000 });
  await readme.click();
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'));
  await window.keyboard.press('Meta+Alt+KeyC');
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(path.join(workspaceRoot, 'README.md'));
  await window.keyboard.press('Meta+Shift+Alt+KeyC');
  await expect.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('README.md');

  await openWorkspaceFile(window, ['src', 'a.ts']);
  await window.locator(CM).click();
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('sentinel'));
  await window.keyboard.press('Meta+Alt+KeyC');
  await window.waitForTimeout(300);
  expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('sentinel');
});

test('Markdown 编辑模式粘贴网页 HTML:图片 title 不取 alt,代码块保留语言', async ({ electronApp, window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'paste-html.md');
  writeFileSync(file, '# T\n');
  await openWorkspaceFile(window, ['paste-html.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await pm.getByText('T').first().click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await electronApp.evaluate(({ clipboard, ClipboardItem }) =>
    clipboard.write([
      new ClipboardItem({
        'text/plain': 'x = 1',
        'text/html': '<p><img src="a.png" alt="cat"></p><pre><code class="language-python">x = 1</code></pre>',
      }),
    ]),
  );
  await window.keyboard.press('Meta+KeyV');
  await window.keyboard.press('Meta+KeyS');
  await expect(async () => {
    const md = await readFile(file, 'utf8');
    expect(md).toContain('![cat](a.png)');
    expect(md).not.toContain('"cat"');
    expect(md).toContain('```python\nx = 1\n```');
  }).toPass({ timeout: 5_000 });
});

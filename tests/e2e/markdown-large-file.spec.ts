// 较大 Markdown(超过 10 万字符)在编辑 / 预览模式下以源码模式打开并给一行提示;窗口级模式不变;手动切到预览时先显示
// 「正在渲染」再按预览渲染。BDD: src/__tests__/markdown-large-file/
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
  editorModeButton,
  editorTab,
  openWorkspaceFile,
} from './helpers/editor';

const LARGE_BANNER = /(文件较大|This file is large|파일이 커서)/;
const RENDERING = /(正在渲染较大的文件|Rendering a large file|큰 파일을 렌더링하는 중)/;

test('编辑模式下打开较大 Markdown → 源码 + 提示;小文件仍是编辑;手动切预览 → 正在渲染 → 只读预览', async ({
  window,
  workspaceRoot,
}) => {
  test.setTimeout(90_000);
  const parts = ['# Big doc', ''];
  for (let i = 0; i < 2500; i++) parts.push(`Paragraph ${i} with **bold** and \`code\` filler text here.`, '');
  writeFileSync(path.join(workspaceRoot, 'big.md'), parts.join('\n'));

  await openWorkspaceFile(window, ['README.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  await expect(window.locator('main .milkdown .ProseMirror')).toBeVisible({ timeout: 10_000 });

  await openWorkspaceFile(window, ['big.md']);
  await expect(window.locator('main .cm-content')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('main .milkdown')).toHaveCount(0);
  await expect(window.locator('main').getByText(LARGE_BANNER)).toBeVisible();
  await expect(editorModeButton(window, EDITOR_MODE_SOURCE)).toHaveAttribute('aria-checked', 'true');

  // 窗口级模式未被改写:小文件仍按编辑模式打开
  await editorTab(window, /^README\.md/).click();
  await expect(window.locator('main .milkdown .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 });
  await expect(window.locator('main').getByText(LARGE_BANNER)).toHaveCount(0);

  await editorTab(window, /^big\.md/).click();
  await expect(window.locator('main .cm-content')).toBeVisible({ timeout: 10_000 });
  // 「正在渲染」只在点击后到 Milkdown 同步长渲染结束之间存在,渲染占住界面线程 → Playwright 轮询要到渲染结束才执行,
  // 直接 toBeVisible 必然错过。点击前在页面里装 MutationObserver,记录提示出现过。
  await window.evaluate((source) => {
    const re = new RegExp(source);
    const w = window as unknown as { __sawRenderingLarge?: boolean };
    w.__sawRenderingLarge = false;
    const main = document.querySelector('main')!;
    const mo = new MutationObserver(() => {
      for (const el of main.querySelectorAll('[role="status"]')) {
        if (re.test(el.textContent ?? '')) {
          w.__sawRenderingLarge = true;
          mo.disconnect();
          return;
        }
      }
    });
    mo.observe(main, { subtree: true, childList: true, characterData: true });
  }, RENDERING.source);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm).toHaveAttribute('contenteditable', 'false', { timeout: 30_000 });
  await expect(pm.locator('h1')).toHaveText('Big doc');
  expect(
    await window.evaluate(() => (window as unknown as { __sawRenderingLarge?: boolean }).__sawRenderingLarge),
  ).toBe(true);
  await expect(window.locator('main').getByText(RENDERING)).toHaveCount(0, { timeout: 10_000 });
  await expect(window.locator('main').getByText(LARGE_BANNER)).toHaveCount(0);
});

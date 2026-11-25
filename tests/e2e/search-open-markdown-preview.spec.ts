// 在文件中查找打开 Markdown 结果,预览(只读)模式:ProseMirror 在 contenteditable=false 时不画 DOM 选区,匹配改用「当前匹配」
// 高亮标出并滚入视图;点击正文后清除。BDD: src/__tests__/search-open-markdown/
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';

const QUERY = /^(搜索|Search|검색)$/;
const STATUS = '[data-testid=search-panel] [role=status]';

test('Markdown 预览模式:点击结果后匹配有可见高亮且在视口内,点击正文清除', async ({ window, workspaceRoot }) => {
  const parts = ['# Long doc', ''];
  for (let i = 0; i < 80; i++) parts.push(`Paragraph ${i} ${i === 70 ? 'has the **zebra** word' : 'is filler text'}.`, '');
  writeFileSync(path.join(workspaceRoot, 'long.md'), parts.join('\n'));
  await openWorkspaceFile(window, ['long.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('h1')).toHaveText('Long doc', { timeout: 10_000 });
  await expect(pm).toHaveAttribute('contenteditable', 'false');

  await waitForTestHooks(window);
  await window.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('zebra');
  await expect(window.locator(STATUS)).toContainText(/1/, { timeout: 10_000 });
  await window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ }).getByRole('treeitem').nth(1).click();

  const mark = pm.locator('.co-find-match-current');
  await expect(mark).toHaveText('zebra', { timeout: 10_000 });
  // 真的画出来了:有非透明背景,且在滚动容器视口内
  const bg = await mark.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  const scroller = window.locator('main .milkdown').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]');
  await expect(async () => {
    const m = (await mark.boundingBox())!;
    const s = (await scroller.boundingBox())!;
    expect(m.y).toBeGreaterThanOrEqual(s.y);
    expect(m.y + m.height).toBeLessThanOrEqual(s.y + s.height);
  }).toPass({ timeout: 3_000 });
  await window.screenshot({ path: test.info().outputPath('search-open-markdown-preview.png') });

  await mark.click();
  await expect(pm.locator('.co-find-match-current')).toHaveCount(0);
});

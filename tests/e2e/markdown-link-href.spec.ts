// Markdown 链接地址在 Edit(Milkdown)里不被清空(见 src/__tests__/editor-markdown-link-href/README.md)。
// 回归:@milkdown/preset-commonmark ≥7.22 的 sanitizeLinkHref 把盘符路径 / co: 链接的 href 置空;链接气泡
// 不改内容直接回车会把地址替换成 "",保存后文件里变成 `[x]()`。
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';

const DOC = ['# Links', '', '[drive](C:/proj/a.md)', '', '[app](co://open?x)', ''].join('\n');

test('Edit:盘符 / co: 链接带原地址;气泡确认 + 编辑别处保存后文件里地址仍在', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'links.md');
  writeFileSync(file, DOC);
  await openWorkspaceFile(window, ['links.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();

  const pm = window.locator('main .milkdown .ProseMirror');
  const drive = pm.locator('a', { hasText: 'drive' });
  await expect(drive).toHaveAttribute('href', 'C:/proj/a.md', { timeout: 10_000 });
  await expect(pm.locator('a', { hasText: 'app' })).toHaveAttribute('href', 'co://open?x');

  // 悬停链接 → 预览气泡显示原地址 → 编辑 → 不改内容直接回车(预览气泡只在编辑器有焦点时响应悬停)
  await pm.locator('h1').click();
  await drive.hover();
  const preview = window.locator('.milkdown-link-preview');
  await expect(preview.locator('.link-display')).toHaveText('C:/proj/a.md');
  await preview.locator('.link-edit-button').click();
  const input = window.locator('.milkdown-link-edit input');
  await expect(input).toHaveValue('C:/proj/a.md');
  await input.press('Enter');
  await expect(drive).toHaveAttribute('href', 'C:/proj/a.md');

  await pm.locator('h1').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' edited');
  await window.keyboard.press('ControlOrMeta+KeyS');

  await expect(async () => {
    const content = await readFile(file, 'utf8');
    expect(content).toContain('edited');
    expect(content).toContain('[drive](C:/proj/a.md)');
    expect(content).toContain('[app](co://open?x)');
  }).toPass({ timeout: 5_000 });
});

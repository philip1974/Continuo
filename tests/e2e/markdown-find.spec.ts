// Markdown 编辑 / 预览模式 ⌘F 查找(见 src/__tests__/markdown-find/README.md)。
// 回归:Milkdown 没有查找,⌘F 无反应。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';

// 标签同代码编辑器查找面板「查找」(editor.cm.find)
const FIND_INPUT = /^(查找|Find|찾기)$/;

/** 60 段正文,第 3 / 30 / 58 段含 needle:后两处在首屏之外,跳转须滚动。 */
function longDoc(): string {
  const parts = ['# Find doc', ''];
  for (let i = 0; i < 60; i++) {
    parts.push(`Paragraph ${i} ${i === 3 || i === 30 || i === 58 ? 'has the **needle** here' : 'is filler text'}.`, '');
  }
  return parts.join('\n');
}

async function expectInView(match: Locator, scroller: Locator): Promise<void> {
  await expect(async () => {
    const m = (await match.boundingBox())!;
    const s = (await scroller.boundingBox())!;
    expect(m.y).toBeGreaterThanOrEqual(s.y);
    expect(m.y + m.height).toBeLessThanOrEqual(s.y + s.height);
  }).toPass({ timeout: 3_000 });
}

async function runFind(window: Page, focusTarget: Locator, shot: string): Promise<void> {
  const pm = window.locator('main .milkdown .ProseMirror');
  const scroller = window.locator('main .milkdown').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]');
  await focusTarget.click();
  await window.keyboard.press('ControlOrMeta+KeyF');
  const input = window.getByRole('textbox', { name: FIND_INPUT });
  await expect(input).toBeFocused();
  // 选项 toggle 与在文件中查找 / 代码编辑器查找同顺序同字形(src/__tests__/find-options-parity)
  await expect(window.getByRole('group', { name: /^(搜索选项|Search options|검색 옵션)$/ }).locator('button')).toHaveText(['Aa', 'ab', '.*']);
  await window.keyboard.type('needle');
  const status = window.locator('main [role="status"]', { hasText: /\d+ \/ 3/ });
  await expect(status).toHaveText('1 / 3');
  await expect(pm.locator('.co-find-match')).toHaveCount(3);
  await window.keyboard.press('Enter');
  await expect(status).toHaveText('2 / 3');
  await expectInView(pm.locator('.co-find-match-current'), scroller);
  await window.keyboard.press('Enter');
  await expect(status).toHaveText('3 / 3');
  await expectInView(pm.locator('.co-find-match-current'), scroller);
  await window.screenshot({ path: test.info().outputPath(shot) });
  await window.keyboard.press('Shift+Enter');
  await expect(status).toHaveText('2 / 3');
  await window.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(pm.locator('.co-find-match')).toHaveCount(0);
  await expect(pm).toBeFocused();
}

test('编辑模式 ⌘F:计数、Enter / ⇧Enter 跳转并滚入视图,Esc 关闭焦点回编辑区(选区在当前匹配)', async ({
  window,
  workspaceRoot,
}) => {
  writeFileSync(path.join(workspaceRoot, 'find.md'), longDoc());
  await openWorkspaceFile(window, ['find.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('h1')).toHaveText('Find doc', { timeout: 10_000 });
  await runFind(window, pm.locator('h1'), 'md-find-edit.png');
  expect(await window.evaluate(() => document.getSelection()?.toString())).toBe('needle');
});

test('预览模式 ⌘F:同样可查找跳转', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'find.md'), longDoc());
  await openWorkspaceFile(window, ['find.md']);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('h1')).toHaveText('Find doc', { timeout: 10_000 });
  await runFind(window, pm.locator('h1'), 'md-find-preview.png');
});

test('与代码编辑器查找一致:选区带入、⌘G / F3 跳转、↑ 翻历史、切 tab 回来恢复查找条与高亮、非法正则提示', async ({
  window,
  workspaceRoot,
}) => {
  writeFileSync(path.join(workspaceRoot, 'find.md'), longDoc());
  await openWorkspaceFile(window, ['find.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = window.locator('main .milkdown .ProseMirror');
  await expect(pm.locator('h1')).toHaveText('Find doc', { timeout: 10_000 });

  // 双击选中第一个 needle → ⌘F 带入查找框
  await pm.locator('strong', { hasText: 'needle' }).first().dblclick();
  await window.keyboard.press('ControlOrMeta+KeyF');
  const input = window.getByRole('textbox', { name: FIND_INPUT });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('needle');
  const status = window.locator('main [role="status"]', { hasText: /\d+ \/ 3/ });
  await expect(status).toHaveText('1 / 3');

  // 正文里 ⌘G(mac)/ F3 下一个,⇧F3 上一个;查找框里 F3 同样跳
  await pm.locator('h1').click();
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyG' : 'F3');
  await expect(status).toHaveText('1 / 3');
  await window.keyboard.press('F3');
  await expect(status).toHaveText('2 / 3');
  await window.keyboard.press('Shift+F3');
  await expect(status).toHaveText('1 / 3');
  await input.focus();
  await window.keyboard.press('F3');
  await expect(status).toHaveText('2 / 3');
  await window.keyboard.press('Enter'); // 记入历史

  // 切到另一个 tab 再切回:查找条、查找词与高亮恢复,焦点不在查找框
  await openWorkspaceFile(window, ['README.md']);
  await expect(input).toHaveCount(0);
  await openWorkspaceFile(window, ['find.md']);
  await expect(input).toHaveValue('needle');
  await expect(pm.locator('.co-find-match')).toHaveCount(3);
  await expect(input).not.toBeFocused();

  // 非法正则:提示「正则表达式无效」,title 带 RegExp 错误信息
  await window.getByRole('button', { name: /^(使用正则表达式|Use Regular Expression|정규식 사용)$/ }).click();
  await input.fill('needle(');
  const invalid = window.locator('main [role="status"]', { hasText: /^(正则表达式无效|Invalid regular expression|잘못된 정규식)$/ });
  await expect(invalid).toBeVisible();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAttribute('title', /Invalid regular expression/);
  await window.screenshot({ path: test.info().outputPath('md-find-invalid-regex.png') });

  // ↑ 翻回历史里的 needle
  await input.press('ArrowUp');
  await expect(input).toHaveValue('needle');
  await expect(status).toHaveText(/\d+ \/ 3/);
});

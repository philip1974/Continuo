// 编辑器查找 / 替换框里拼音组字时按 Esc:Esc 是取消组字,不关查找条(组字结束后 Esc 照常关闭)。
// BDD: src/__tests__/editor-find-widget/(输入法组字)、src/__tests__/hotkey-ime-composition/
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';

/** 在当前焦点元素上派发组字中的 Esc(isComposing,同 Chromium 组字期间的 keydown;keyCode 229 由 init 带上)。 */
async function composingEscape(win: Page): Promise<void> {
  await win.evaluate(() => {
    const el = document.activeElement!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
  });
}

test('查找框 / 替换框:组字中 Esc 不关查找条,组字结束后 Esc 关闭', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'ime.ts'), 'const foo = 1;\nconst bar = 2;\n');
  await openWorkspaceFile(window, ['ime.ts']);
  await expect(window.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });

  await window.locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+KeyF');
  const search = window.locator('.cm-search [name="search"]');
  await expect(search).toBeFocused();
  const panel = window.locator('.cm-search');

  // 真实输入法组字(CDP imeSetComposition)期间按 Esc
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await composingEscape(window);
  await expect(panel).toBeVisible();
  await cdp.send('Input.insertText', { text: '你' });
  await expect(search).toHaveValue('你');

  // 替换框同样
  const replace = window.locator('.cm-search input[name="replace"]');
  await replace.focus();
  await cdp.send('Input.imeSetComposition', { text: 'hao', selectionStart: 3, selectionEnd: 3 });
  await composingEscape(window);
  await expect(panel).toBeVisible();
  await cdp.send('Input.insertText', { text: '好' });
  await expect(replace).toHaveValue('好');

  // 组字结束后 Esc 照常关闭
  await window.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await cdp.detach();
});

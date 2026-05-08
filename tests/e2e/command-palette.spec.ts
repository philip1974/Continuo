// 命令面板与 Quick Open 全局快捷键。
//
// 用 dispatchEvent 直接派发 keydown,绕过 Electron / OS 层可能的 Cmd/Ctrl+P
// 拦截(menu / 系统快捷键)。renderer 内 useQuickOpenHotkey + useCommandPaletteHotkey
// 都检测 metaKey || ctrlKey,只读 e.key,跑测时稳定。

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';

async function pressShortcut(
  window: Page,
  opts: { ctrl?: boolean; shift?: boolean; key: string },
): Promise<void> {
  await window.evaluate(
    ({ ctrl, shift, key }) => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          ctrlKey: ctrl ?? false,
          shiftKey: shift ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    opts,
  );
}

test('Ctrl+Shift+P 打开命令面板,Esc 关闭', async ({ window }) => {
  await pressShortcut(window, { ctrl: true, shift: true, key: 'p' });

  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('Ctrl+P 打开 Quick Open(无 workspace 时显占位)', async ({ window }) => {
  await pressShortcut(window, { ctrl: true, key: 'p' });

  const input = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
  await expect(input).toBeVisible();

  await expect(window.locator('.wm-modal-content')).toContainText(
    '请先在 Explorer 打开工作区',
  );

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('命令面板输入 query → 列表过滤', async ({ window }) => {
  await pressShortcut(window, { ctrl: true, shift: true, key: 'p' });
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();

  const items = window.locator('.wm-modal-content li');
  const total = await items.count();
  expect(total).toBeGreaterThan(0);

  await input.fill('zz_no_such_command_xx');
  await expect(window.locator('.wm-modal-content')).toContainText(
    '无匹配命令',
  );

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

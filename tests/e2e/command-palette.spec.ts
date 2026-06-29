// 命令面板与 Quick Open 全局快捷键。
//
// 用 dispatchEvent 直接派发 keydown,绕过 Electron / OS 层可能的 Cmd/Ctrl+P
// 拦截(menu / 系统快捷键)。renderer 内 useQuickOpenHotkey + useCommandPaletteHotkey
// 都检测 metaKey || ctrlKey,只读 e.key,跑测时稳定。

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const QUICK_OPEN_SEARCH = /^(搜索文件|Search files|파일 검색)$/;
const QUICK_OPEN_NO_WORKSPACE =
  /^(请先在 Explorer 打开工作区|Please open a workspace in Explorer first|먼저 Explorer에서 워크스페이스를 여세요)$/;
const COMMAND_NO_MATCH = /^(无匹配命令|No matching command|일치하는 명령어 없음)$/;

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

async function waitForShellReady(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });
}

test('Ctrl+Shift+P 打开命令面板,Esc 关闭', async ({ window }) => {
  await waitForShellReady(window);
  await pressShortcut(window, { ctrl: true, shift: true, key: 'p' });

  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('Ctrl+P 打开 Quick Open(无 workspace 时显占位)', async ({ window }) => {
  await waitForShellReady(window);
  await pressShortcut(window, { ctrl: true, key: 'p' });

  const input = window.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();

  await expect(
    window.getByRole('status').filter({ hasText: QUICK_OPEN_NO_WORKSPACE }),
  ).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('命令面板输入 query → 列表过滤', async ({ window }) => {
  await waitForShellReady(window);
  await pressShortcut(window, { ctrl: true, shift: true, key: 'p' });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  const items = window.getByRole('listbox').getByRole('option');
  const total = await items.count();
  expect(total).toBeGreaterThan(0);

  await input.fill('zz_no_such_command_xx');
  await expect(
    window.getByRole('status').filter({ hasText: COMMAND_NO_MATCH }),
  ).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

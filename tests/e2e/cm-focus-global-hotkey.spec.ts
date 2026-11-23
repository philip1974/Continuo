// CodeMirror 聚焦时 → Cmd+Shift+P 仍打开命令面板.
// useCommandPaletteHotkey(usePickerToggleHotkey)监听 document,CM 不阻断 keydown bubble.
import { test, expect } from './fixtures/with-workspace';

const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;

test('CM 聚焦 + Cmd+Shift+P → 命令面板打开', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();

  // 在 CM 内真实按键,验证 document 级监听仍能收到
  await cm.press('ControlOrMeta+Shift+KeyP');

  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible({ timeout: 5_000 });
});

// CommandPalette 输入 regex 元字符 / 中文 / emoji,fuzzy 不抛 + UI 仍正常.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const TRICKY = ['(.*)+?', '[abc\\]', '中文搜索', '😀✨', '"`<>$&|;'];

async function openPalette(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

test('特殊字符 query 不抛 + modal 仍开', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await openPalette(window);
  const dialog = window.getByRole('dialog', { name: COMMAND_SEARCH });
  const input = dialog.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  for (const q of TRICKY) {
    await input.fill(q);
    // input 仍可见 = 没崩;modal 应仍存在
    await expect(dialog).toBeVisible();
    await expect(input).toBeVisible();
    // input 值 = 我们填的
    await expect(input).toHaveValue(q);
  }

  // 清空 → 列表回到全部 cmd
  await input.fill('');
  await expect(input).toBeVisible();
});

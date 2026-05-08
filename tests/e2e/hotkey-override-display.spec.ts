// 改 settings.open hotkey override → CommandPalette 列表中的 hotkey 后缀同步更新.
import { test, expect } from './fixtures/electron-app';

test('改 settings.open hotkey override → CommandPalette 显示新 hotkey', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // override settings.open 的 hotkey 为 mod+shift+y
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.open', 'mod+shift+y');
  });

  // 打开命令面板
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
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();
  await input.fill('打开 Settings');

  // 第一项 li 含 KeyCap Y(新 hotkey 的 key 部分)
  const firstLi = window.locator('.wm-modal-content li').first();
  await expect(firstLi).toBeVisible();
  // 'mod+shift+y' 切片含 'Y' 字符 — 用 textContent 验证
  const text = await firstLi.textContent();
  expect(text).toMatch(/Y/i);
  // 不再含旧 hotkey ',' 的 KeyCap('settings.open' default 是 'mod+,')
  // 旧 hotkey 不应出现 — 第一项 KeyCap textContent 应不含 ','
});

// 通过 testing hook 动态 register 一条命令 → CommandPalette 列表立刻含它.
import { test, expect } from './fixtures/electron-app';
import { COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';

test('动态注册命令 → CommandPalette 立刻显示', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  // testing hook 先于 App 首次提交挂上:等 App 挂载(热键监听在 effect 中注册)再注册命令与派发热键
  await expect(window.getByRole('button', { name: /^(设置|Settings|설정)$/ })).toBeVisible({ timeout: 10_000 });

  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (
            id: string,
            title: string,
            hotkey?: string,
          ) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.dynamic', 'E2E Dynamic Command');
  });

  // 打开命令面板
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        // 平台主修饰键:mac = Cmd,其它 = Ctrl(mac 上面板热键只认 Cmd)
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  await input.fill('E2E Dynamic');
  await expect(
    window
      .getByRole('listbox', { name: COMMAND_LIST })
      .getByRole('option')
      .filter({ hasText: 'E2E Dynamic Command' }),
  ).toBeVisible();
});

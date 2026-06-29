// CommandPalette fuzzy 匹配 — 本地化标签 + 跨字符匹配.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;
const SETTINGS_TITLE = /(切换 Settings|Toggle Settings|설정 토글)/;

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

function sparseQueryFrom(text: string): string {
  const chars = Array.from(text.replace(/[\s:：-]+/g, ''));
  return `${chars[0] ?? ''}${chars.at(-1) ?? ''}`.toLocaleLowerCase();
}

test('本地化 Settings 查询能匹配 settings.toggle 命令', async ({
  window,
}) => {
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({
    timeout: 10_000,
  });

  const settingsQuery =
    (await settingsButton.getAttribute('title'))?.toLocaleLowerCase() ??
    'settings';

  await openPalette(window);
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  await input.fill(settingsQuery);
  const settingsOption = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_TITLE });
  await expect(settingsOption).toBeVisible();
});

test('跨字符模糊查询匹配 settings.toggle 命令', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await openPalette(window);
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  const settingsOption = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_TITLE });
  await expect(settingsOption).toBeVisible();

  await input.fill(sparseQueryFrom((await settingsOption.innerText()) ?? ''));
  await expect(settingsOption).toBeVisible();
});

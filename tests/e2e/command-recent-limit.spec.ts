// CommandPalette recent:MAX_RECENT=20,LRU 顺序;
// 重复执行同 id → 移到头部不重复.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;
const SETTINGS_TITLE = /(切换 Settings|Toggle Settings|설정 토글)/;
const CLOSE_SETTINGS = /^(关闭 Settings|Close Settings|Settings 닫기)$/;

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

test('多次执行同命令 → recent 不重复 + 该命令始终置顶', async ({
  window,
}) => {
  // 等就绪
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({
    timeout: 10_000,
  });
  const settingsQuery =
    (await settingsButton.getAttribute('title'))?.toLocaleLowerCase() ??
    'settings';

  // 三次执行 settings.toggle
  for (let i = 0; i < 3; i++) {
    await openPalette(window);
    const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
    await expect(input).toBeVisible();
    await input.fill(settingsQuery);
    const settingsCommand = window
      .getByRole('listbox', { name: COMMAND_LIST })
      .getByRole('option')
      .filter({ hasText: SETTINGS_TITLE });
    await expect(settingsCommand).toBeVisible();
    await settingsCommand.click();
    await expect(input).toBeHidden();

    // 关掉 settings panel(避免堆叠)
    const closeSettings = window.getByRole('button', { name: CLOSE_SETTINGS });
    if (await closeSettings.count()) {
      await closeSettings.click();
      await window.waitForTimeout(300);
    }
  }

  // 第四次打开命令面板 → 第一项仍是 Settings 相关(LRU 头部不重复)
  await openPalette(window);
  const options = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option');
  const firstItem = options.first();
  await expect(firstItem).toContainText(SETTINGS_TITLE);

  // 由于 settings.toggle 是唯一带 Settings category 的命令,只占 1 个 option
  const settingsCount = await options.filter({ hasText: SETTINGS_TITLE }).count();
  expect(settingsCount).toBe(1);
});

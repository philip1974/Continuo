// CommandPalette recent:MAX_RECENT=20,LRU 顺序;
// 重复执行同 id → 移到头部不重复.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, CLOSE_SETTINGS } from './helpers/settings';
import { COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const SETTINGS_TITLE = /(打开设置|Open Settings|설정 열기)/;

test('多次执行同命令 → recent 不重复 + 该命令始终置顶', async ({
  window,
}) => {
  // 等就绪
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({
    timeout: 10_000,
  });
  const settingsQuery =
    (await settingsButton.getAttribute('aria-label'))?.toLocaleLowerCase() ??
    'settings';

  // 三次执行「首选项: 打开设置」
  for (let i = 0; i < 3; i++) {
    await dispatchModKey(window, 'p', { shift: true });
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
  await dispatchModKey(window, 'p', { shift: true });
  const options = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option');
  const firstItem = options.first();
  await expect(firstItem).toContainText(SETTINGS_TITLE);

  // recent 存储(LRU)里 id 唯一,workbench.action.openSettings(「首选项: 打开设置」)只出现一次且在首位(面板每个命令只渲染一行,
  // 所以要直接看存储才能验证「不重复」)
  const ids = await window.evaluate(() => {
    const raw = localStorage.getItem('continuo:command-palette:recent');
    return raw ? (JSON.parse(raw) as Array<{ id: string }>).map((e) => e.id) : [];
  });
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => id === 'workbench.action.openSettings')).toHaveLength(1);
  expect(ids[0]).toBe('workbench.action.openSettings');
});

// CommandPalette 输入空格 → trim 后视为空 query → 显 recent / 全部命令.
// 实际行为:fuzzy 匹配空字符串 → 全匹配.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;

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

test('全空格 query → 列表项 = 全部命令(等同空 query)', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await openPalette(window);
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();
  const options = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option');

  // 空 query 状态下记录初始数
  const initial = await options.count();
  expect(initial).toBeGreaterThan(0);

  // 输入空格
  await input.fill('   ');
  // 全空格 fuzzy 不过滤,数量同初始
  const afterSpaces = await options.count();
  expect(afterSpaces).toBe(initial);
});

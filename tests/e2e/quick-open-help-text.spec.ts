// Quick Open 输入框 placeholder 含 ⌘⇧P 切到命令面板的提示.
import { test, expect } from './fixtures/electron-app';
import {
  QUICK_OPEN_PLACEHOLDER,
  openQuickOpen,
  quickOpenInput,
} from './helpers/palette';

test('Quick Open 输入框 placeholder 含「⌘⇧P 切到命令面板」', async ({
  window,
}) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  const placeholder = await input.getAttribute('placeholder');
  expect(placeholder ?? '').toMatch(QUICK_OPEN_PLACEHOLDER);
  // 提示用户 ⌘⇧P 是命令面板
  expect(placeholder).toContain('⌘⇧P');
});

// Quick Open ArrowDown / Enter 键盘流程.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('ArrowDown 移到第二项 → Enter 打开 b.ts(不是默认第一项)', async ({
  window,
}) => {
  // 展开 src(walk-files 不依赖 expand,但 Explorer 显示一致)
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();

  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 输入 .ts 缩到 a.ts / b.ts 两项
  await input.fill('.ts');
  await expect(window.locator('.wm-modal-content li').first()).toBeVisible();

  // selectedIndex=0(a.ts);ArrowDown → 1(b.ts);Enter 打开 b.ts
  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Enter');

  await expect(input).toBeHidden();
  await expect(window.locator('header').first()).toContainText('b.ts', {
    timeout: 10_000,
  });
});

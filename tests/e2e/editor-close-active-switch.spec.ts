// 关闭 active tab → editor.store 自动切到下一个 tab(VSCode 同款).
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_CLOSE_B_TS,
  EDITOR_CLOSE_README_MD,
  EDITOR_TABS,
  editorTab,
} from './helpers/editor';

test('打开 README.md + a.ts + b.ts(active)→ 关 b.ts → active 自动切回', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();
  // 此时 b.ts active
  await expect(window.locator('header').first()).toContainText('b.ts');

  // 关 b.ts(TabNav close button)
  const closeB = window.getByRole('button', { name: EDITOR_CLOSE_B_TS });
  await closeB.click();
  await window.waitForTimeout(300);

  // active 自动切到 a.ts(b.ts 之前的 tab)— editor.store 切到 idx-1
  // 剩余 tab 的 tablist 中 a.ts 出现在 header
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 5_000,
  });
});

test('关 README.md(非 active)→ active 不变(仍 b.ts)', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  const closeReadme = window.getByRole('button', {
    name: EDITOR_CLOSE_README_MD,
  });
  await closeReadme.click();

  // README 的 tab 确实已关闭(否则「active 不变」恒成立),剩 a.ts / b.ts 两个 tab
  await expect(
    window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab').filter({ hasText: /^README\.md/ }),
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab')).toHaveCount(2);

  // active 仍 b.ts(关闭非 active 不切)
  await expect(window.locator('header').first()).toContainText('b.ts');
});

// VSCode focusRecentEditorAfterClose(默认 true):回到组内最近使用的 tab,而不是位置相邻的。
// BDD: src/__tests__/editor-close-mru/
test('README → a.ts → b.ts,切回 README 再切到 b.ts → 关 b.ts 回到 README(最近使用),不是相邻的 a.ts', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();
  await editorTab(window, /^README\.md/).click();
  await expect(window.locator('header').first()).toContainText('README.md');
  await editorTab(window, /^b\.ts/).click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  await window.getByRole('button', { name: EDITOR_CLOSE_B_TS }).click();
  await expect(window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab')).toHaveCount(2);
  await expect(window.locator('header').first()).toContainText('README.md', { timeout: 5_000 });
});

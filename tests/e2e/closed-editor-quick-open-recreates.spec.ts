// 关 Editor → Cmd+P 选文件 → editor.store.openTab → DockShell useEffect 自动 addPanel.
import { test, expect } from './fixtures/with-workspace';

const CLOSE_EDITOR =
  /^(Close (Editor|编辑器|편집기)|关闭 (Editor|编辑器|편집기)|(Editor|编辑器|편집기) 닫기)$/;
const QUICK_OPEN_SEARCH = /^(搜索文件|Search files|파일 검색)$/;
const QUICK_OPEN_RESULTS = /^(文件搜索结果|File search results|파일 검색 결과)$/;

test('关 Editor → Cmd+P 选 README.md → Editor 自动重建 + 显 README.md', async ({
  window,
}) => {
  // 关 Editor → EmptyState
  await window.getByRole('button', { name: CLOSE_EDITOR }).click();
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeVisible({ timeout: 5_000 });

  // Cmd+P → 选 README.md
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();
  await input.fill('README');
  await expect(
    window.getByRole('listbox', { name: QUICK_OPEN_RESULTS }),
  ).toBeVisible();
  await expect(
    window.getByRole('option', { name: /README\.md/ }).first(),
  ).toBeVisible();
  await window.keyboard.press('Enter');

  // Editor panel 自动重建 + 显 README.md
  await expect(input).toBeHidden({ timeout: 5_000 });
  await expect(window.getByText('README.md').first()).toBeVisible({
    timeout: 10_000,
  });
  // EmptyState 消失
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeHidden({ timeout: 5_000 });
});

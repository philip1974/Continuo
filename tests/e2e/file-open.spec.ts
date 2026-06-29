// 双击文件 → Editor 打开 tab + 内容显示.
import { test, expect } from './fixtures/with-workspace';

const LINE_COUNT = /(行|lines|줄)/;
const QUICK_OPEN_SEARCH = /^(搜索文件|Search files|파일 검색)$/;

test('点击 README.md → Editor 打开 + StatusBar 显示行/词/字符', async ({
  window,
}) => {
  // 先确认 README.md 在 FolderTree 里渲染
  const readmeRow = window.locator('text=README.md').first();
  await expect(readmeRow).toBeVisible({ timeout: 10_000 });

  // 单击 → openFileByPath(VSCode 同款单击打开预览,我们的实现是单击直接打开)
  await readmeRow.click();

  // EditorHeader 单 tab 紧凑模式:文件名出现在 Editor 顶部
  // 至少 dock 中渲染了 README.md 文本 / 内容
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // StatusBar 行/词/字符
  const status = window.locator('footer');
  await expect(status).toContainText('README.md');
  await expect(status).toContainText(LINE_COUNT);
});

test('Ctrl+P 选 a.ts + Enter 打开', async ({ window, workspaceRoot }) => {
  void workspaceRoot; // 保留语义,Quick Open 走 walk(workspace)
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

  await input.fill('a.ts');
  // 等列表更新
  await expect(window.getByRole('listbox')).toContainText('a.ts', {
    timeout: 10_000,
  });

  await window.keyboard.press('Enter');
  // Modal 关 + Editor 打开 a.ts
  await expect(input).toBeHidden();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });
});

// PluginsTabContent 的「已注册贡献点」行,数字与运行时 registry 一致.
import { test, expect } from './fixtures/electron-app';

test('Plugin tab 显示的命令数 = testing hook commandCount()', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  const cmdCount = (await window.evaluate(() =>
    (
      window as unknown as {
        __continuoTest: { commandCount: () => number };
      }
    ).__continuoTest.commandCount(),
  )) as number;
  expect(cmdCount).toBeGreaterThanOrEqual(1);

  // 打开 Plugin tab
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  // 「命令」行的 count cell(数字)= cmdCount
  // 「命令」label 文案 + 同行的 .tabular-nums.w-8 含 count
  // 简化:在 main 内查找含 "命令" 的 row 后取数字
  const main = window.locator('main');
  const cmdRow = main
    .locator('div')
    .filter({ has: main.locator('div.w-32', { hasText: '命令' }) });
  // cmdRow 数字 cell 是 .w-8.text-right.tabular-nums.text-fg
  // 直接读 main 内的 ".tabular-nums" 全集然后找命令对应那一格 — 简化:
  // 用 evaluate 取 DOM 中含「命令」label 的行的 count 数字
  const uiCount = await main.evaluate((root: Element) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some(
        (c) =>
          c.textContent?.trim() === '命令' &&
          c.classList.contains('w-32'),
      ),
    );
    if (rows.length === 0) return -1;
    const numCell = rows[0]!.querySelector('div.tabular-nums');
    return Number(numCell?.textContent?.trim() ?? '0');
  });

  expect(uiCount).toBe(cmdCount);
});

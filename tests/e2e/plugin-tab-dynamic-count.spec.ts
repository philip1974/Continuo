// Plugins tab 「命令」 计数随动态 register 同步 +1.
import { test, expect } from './fixtures/electron-app';

test('register 命令 → 插件 tab 命令计数 +1', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 打开 Settings → 插件 tab
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  // 等贡献点 section
  await expect(window.locator('text=已注册贡献点')).toBeVisible({
    timeout: 10_000,
  });

  // 取「命令」行计数
  const main = window.locator('main');
  const before = await main.evaluate((root: Element) => {
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
  expect(before).toBeGreaterThan(0);

  // register 4 个新命令
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (id: string, title: string) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.pl1', 'PL1');
    t.registerCommand('e2e.pl2', 'PL2');
    t.registerCommand('e2e.pl3', 'PL3');
    t.registerCommand('e2e.pl4', 'PL4');
  });

  // 计数 +4
  await expect(async () => {
    const after = await main.evaluate((root: Element) => {
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
    expect(after).toBe(before + 4);
  }).toPass({ timeout: 5_000 });
});

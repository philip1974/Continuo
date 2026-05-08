// explorer.indentSize 改 → 子级 FileRow paddingLeft 同步.
// level=1(src 下的 a.ts)默认 indent=16 → paddingLeft = 4 + 1*16 = 20px.
// 改成 indent=32 → paddingLeft = 4 + 32 = 36px.
import { test, expect } from './fixtures/with-workspace';

test('改 indentSize=32 → src/a.ts 行 paddingLeft 同步加大', async ({ window }) => {
  await window.locator('text=src').first().click();
  await expect(window.locator('text=a.ts').first()).toBeVisible({
    timeout: 10_000,
  });

  // 取 src/a.ts 行的 paddingLeft
  const aRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first();
  const beforeStyle = await aRow.evaluate((el) => {
    const inner = el.querySelector<HTMLElement>('[style*="padding-left"]');
    return inner ? inner.style.paddingLeft : (el as HTMLElement).style.paddingLeft;
  });

  // 改 indent → 32
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('explorer.indentSize', 32);
  });

  // 等重渲
  await expect(async () => {
    const after = await aRow.evaluate((el) => {
      const inner = el.querySelector<HTMLElement>('[style*="padding-left"]');
      return inner
        ? inner.style.paddingLeft
        : (el as HTMLElement).style.paddingLeft;
    });
    expect(after).not.toBe(beforeStyle);
    expect(after).toContain('36px'); // 4 + 32
  }).toPass({ timeout: 5_000 });
});

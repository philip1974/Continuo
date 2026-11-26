// BDD:src/__tests__/dock-reset-layout —— 「视图:重置布局」不合并编辑器组:⌘\ 拆成两组后执行,两组仍左右分栏(不叠成同一
// dock 组里的两个「编辑器」tab);第二个组的 dock 标题带编号「编辑器 2」(src/__tests__/editor-groups/)。
import { test, expect } from './fixtures/with-workspace';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';

const EDITOR_2_TAB = /^(编辑器 2|Editor 2|편집기 2)/;

test('⌘\\ 拆两组后「重置布局」→ 两个编辑器组仍左右分栏并都可见;第二组 dock 标题「编辑器 2」', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const groups = window.locator('[data-editor-panel-root]');
  await expect(groups.first().locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  await groups.first().locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+Backslash');
  await expect(groups).toHaveCount(2, { timeout: 10_000 });
  await expect(window.locator('.dv-tab [role=tab]', { hasText: EDITOR_2_TAB })).toHaveCount(1);

  await openCommandPalette(window);
  await commandPaletteInput(window).fill('Reset Layout');
  const option = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: /(重置布局|Reset Layout|레이아웃 초기화)/ });
  await expect(option).toHaveCount(1);
  await option.click();

  // 两组都可见(叠成同组 tab 时只有活动的那个可见),且左右并排
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toBeVisible();
  await expect(groups.nth(1)).toBeVisible();
  const [left, right] = await Promise.all([groups.nth(0).boundingBox(), groups.nth(1).boundingBox()]);
  expect(left && right && Math.abs(left.x - right.x) > 50).toBe(true);
});

// VSCode Reset View Locations 不改变活动编辑器组:「编辑器 2」叠进「编辑器」、「编辑器 3」单独时重置,标题栏 / 活动组曾指向
// 编辑器 2 而键入在编辑器 3,或焦点落 body。BDD: src/__tests__/dock-reset-layout(活动编辑器组与焦点)
for (const focusOn of ['standalone', 'stacked'] as const) {
  test(`叠放布局「重置布局」:焦点在${focusOn === 'standalone' ? '单独成组的编辑器 3' : '叠放着的编辑器 2'} → 重置后标题栏与键入都在它`, async ({
    window,
  }) => {
    test.setTimeout(90_000);
    const groups = window.locator('[data-editor-panel-root]');
    await window.locator('text=src').first().click();
    await window.locator('text=a.ts').first().click();
    const first = groups.first().locator('.cm-content');
    await expect(first).toContainText('export const a', { timeout: 10_000 });
    await first.click();
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(groups).toHaveCount(2, { timeout: 10_000 });
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(groups).toHaveCount(3, { timeout: 10_000 });
    // 要聚焦的那个组显示 b.ts(便于认出):单独的 = 最右组,叠放的 = 中间组(随后叠进最左组)
    const marked = groups.nth(focusOn === 'standalone' ? 2 : 1).locator('.cm-content');
    await marked.click();
    await window.locator('text=b.ts').first().click();
    await expect(marked).toContainText('export const b', { timeout: 10_000 });

    // 「编辑器 2」的 dock tab 拖进最左组中央(叠放)
    const target = window
      .locator('.dv-groupview')
      .filter({ has: window.locator('.dv-tab').filter({ hasText: /^(编辑器|Editor|편집기)$/ }) })
      .locator('.dv-content-container');
    const box = (await target.boundingBox())!;
    await window
      .locator('.dv-tab')
      .filter({ hasText: / 2$/ })
      .dragTo(target, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
    await expect(groups).toHaveCount(2, { timeout: 10_000 });

    const b = groups.locator('.cm-content').filter({ hasText: 'export const b' });
    await expect(b).toHaveCount(1);
    // ⌘3 / ⌘2 聚焦该编辑器组(编号按组:叠放着的编辑器 2 仍是第 2 组)
    await window.keyboard.press(focusOn === 'standalone' ? 'ControlOrMeta+3' : 'ControlOrMeta+2');
    await expect(b).toBeFocused();

    await openCommandPalette(window);
    await commandPaletteInput(window).fill('Reset Layout');
    await expect(
      window
        .getByRole('listbox', { name: COMMAND_LIST })
        .getByRole('option')
        .filter({ hasText: /(重置布局|Reset Layout|레이아웃 초기화)/ }),
    ).toHaveCount(1);
    await window.keyboard.press('Enter');

    await expect(groups).toHaveCount(3, { timeout: 10_000 });
    await expect(window.locator('header').first()).toContainText('b.ts');
    const focused = window.locator('[data-editor-panel-root] .cm-content:focus');
    await expect(focused).toHaveCount(1, { timeout: 5_000 });
    await expect(focused).toContainText('export const b');
    await window.keyboard.type('after-reset-');
    await expect(focused).toContainText('after-reset-');
  });
}

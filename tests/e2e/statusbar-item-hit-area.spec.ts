// 状态栏可点击项占满栏高、左右留白、悬停有底色(VSCode .statusbar-item);点在按钮上下边缘也能触发。真实鼠标。
// BDD: src/__tests__/statusbar-item-hit-area/
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';

test('缩进 / 编码 / 行尾 / 位置 / MCP 按钮高度 = 状态栏内高;悬停有底色;点上边缘打开编码选择', async ({ window }) => {
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const footer = window.locator('footer[data-statusbar]');
  const encoding = footer.locator('[data-statusbar-encoding]');
  await expect(encoding).toBeVisible();
  // 位置 / 缩进项在代码编辑器挂载后出现
  await expect(footer.locator('[data-statusbar-selection]')).toBeVisible();
  await expect(footer.locator('[data-statusbar-indentation]')).toBeVisible();
  const footerBox = (await footer.boundingBox())!;
  const buttons = footer.locator('button:visible');
  const n = await buttons.count();
  expect(n).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < n; i++) {
    const b = (await buttons.nth(i).boundingBox())!;
    // 内高 = 状态栏高 − 1px 上边框
    expect(b.height, await buttons.nth(i).textContent() ?? '').toBeGreaterThanOrEqual(footerBox.height - 1.5);
  }

  const box = (await encoding.boundingBox())!;
  const bgOf = () => encoding.evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await bgOf();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(bgOf).not.toBe(before);
  // 原来的按钮只有约 15px 高:点在上边缘 2px 处(落在原文字框之外)仍打开编码动作选择
  await window.mouse.click(box.x + box.width / 2, box.y + 2);
  await expect(window.locator('.wm-modal-content [data-encoding-pick]').first()).toBeVisible();
});

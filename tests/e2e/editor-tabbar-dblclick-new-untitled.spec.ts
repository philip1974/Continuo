// 双击编辑器 tab 栏空白处 → 在该组新建无标题文件(VSCode 同);双击 tab 本身不新建。真实鼠标双击。
// BDD: src/__tests__/editor-tabbar-new-untitled/
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS, openWorkspaceFile } from './helpers/editor';

const UNTITLED = /^(Untitled-1|无标题-1|제목 없음-1)/;

test('双击 tab 栏空白处新建无标题文件并可直接键入;双击 tab 不新建', async ({ window }) => {
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const tablist = window.getByRole('tablist', { name: EDITOR_TABS });
  const tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(1);

  // 双击 tab 本身(常驻 tab 双击无动作;预览 tab 双击 → 常驻)不新建
  await tabs.first().dblclick();
  await expect(tabs).toHaveCount(1);

  // tab 栏空白处(tablist 右端,远离唯一的 tab)
  const box = (await tablist.boundingBox())!;
  const tabBox = (await tabs.first().boundingBox())!;
  expect(box.x + box.width - 20).toBeGreaterThan(tabBox.x + tabBox.width);
  await window.mouse.dblclick(box.x + box.width - 20, box.y + box.height / 2);
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText(UNTITLED);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  // 焦点在新文件的编辑器里:直接键入
  await window.keyboard.type('hello');
  await expect(window.locator('.cm-content').first()).toHaveText('hello');
});

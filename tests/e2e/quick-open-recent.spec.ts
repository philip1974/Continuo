// Quick Open 空查询先列「最近打开」(VSCode 编辑器历史)。BDD: src/__tests__/quick-open-recent/
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const RECENTLY_OPENED = /(最近打开|recently opened|최근에 연 항목)/;

test('打开 b.ts 再 a.ts → ⌘P 空查询:a.ts、b.ts 排最前,首行标「最近打开」', async ({ window }) => {
  await openWorkspaceFile(window, ['src', 'b.ts']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await openQuickOpen(window);
  await expect(quickOpenInput(window)).toHaveValue('');
  const options = window.locator('.wm-modal-content [role=option]');
  await expect(options.nth(0)).toContainText('a.ts');
  await expect(options.nth(0)).toContainText(RECENTLY_OPENED);
  await expect(options.nth(1)).toContainText('b.ts');
  await expect(options.nth(1)).not.toContainText(RECENTLY_OPENED);
  await expect(options.nth(2)).toContainText('README.md');
});

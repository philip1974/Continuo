// 在文件中查找无结果时提示排除设置与 gitignore(VSCode SearchView.onSearchComplete noResultsFound +「打开设置」;
// BDD: src/__tests__/workspace-search/ 8a):提示句 + 「打开设置」打开设置并停在「使用忽略文件」所在页签。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const QUERY = /^(搜索|Search|검색)$/;
const HINT = /(查看设置中配置的排除项并检查 gitignore 文件|Review your settings for configured exclusions and check your gitignore files|설정에서 구성된 제외 항목을 검토하고 gitignore 파일을 확인하세요)/;
const OPEN_SETTINGS = /^(打开设置|Open Settings|설정 열기)$/;
const USE_IGNORE_FILES = /(使用忽略文件|Use ignore files|무시 파일 사용)/i;

test('无结果 → 状态行提示排除设置与 gitignore;「打开设置」打开设置的搜索范围设置页', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'a.txt'), 'hello\n');
  await waitForTestHooks(window);
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('zzz-not-here');
  const panel = window.getByTestId('search-panel');
  await expect(panel.getByRole('status')).toHaveText(HINT, { timeout: 10_000 });
  // 搜索已完成:没有进度条
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await panel.getByRole('button', { name: OPEN_SETTINGS }).click();
  await expect(window.getByText(USE_IGNORE_FILES).first()).toBeVisible({ timeout: 10_000 });
});

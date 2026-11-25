// Quick Open 大工作区(第二十四轮,src/__tests__/quick-open):超过 5000 个文件时根下文件仍可搜到;新建文件下次打开即出现。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const NO_MATCH = /(无匹配文件|No matching files|일치하는 파일 없음)/;

test('6000 个文件的子目录不挤掉根下文件:⌘P 输 file-0 找到根下 file-0.ts;新建文件重开后可搜到', async ({ window, workspaceRoot }) => {
  for (let d = 0; d < 60; d++) {
    const dir = path.join(workspaceRoot, 'huge', `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(path.join(dir, `file-${d * 100 + i}.ts`), '');
  }
  writeFileSync(path.join(workspaceRoot, 'file-0.ts'), '');

  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await input.fill('file-0');
  const modal = window.locator('.wm-modal-content');
  await expect(modal.locator('li[title="file-0.ts"]')).toHaveCount(1, { timeout: 15_000 });
  await input.fill('src/a');
  await expect(modal.locator('li[title="src/a.ts"]')).toHaveCount(1);
  await input.fill('sync.md');
  await expect(modal).toContainText(NO_MATCH);

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden({ timeout: 5_000 });
  writeFileSync(path.join(workspaceRoot, 'sync.md'), '');
  await openQuickOpen(window);
  await quickOpenInput(window).fill('sync.md');
  await expect(modal.locator('li[title="sync.md"]')).toHaveCount(1, { timeout: 15_000 });
});

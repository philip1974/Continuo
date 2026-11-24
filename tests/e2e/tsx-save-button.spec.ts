// .tsx file → 视为代码 → 不显示保存按钮(EditorHeader 对任何文件都不渲染保存按钮).
import { expect, test } from '@playwright/test';
import { EDITOR_SAVE_LABEL } from './helpers/editor';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('Component.tsx → 不显示 Save button', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-tsx-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-tsx-ws-'));
  try {
    writeFileSync(
      path.join(ws, 'Component.tsx'),
      'export const X = () => null;\n',
    );
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.locator('text=Component.tsx').first().click();
    await expect(win.locator('header').first()).toContainText(
      'Component.tsx',
      { timeout: 10_000 },
    );

    // 先确认代码编辑器已挂载(TitleBar 直接订阅 store,早于懒加载的 Editor 面板),否定断言才有意义
    await expect(win.locator('.cm-content')).toContainText('export const X', {
      timeout: 10_000,
    });
    const saveBtn = win
      .getByRole('button', { name: EDITOR_SAVE_LABEL });
    await expect(saveBtn).toHaveCount(0);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

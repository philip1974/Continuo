// Quick Open walk 不过滤 dot 文件,即使关掉 showHiddenFiles 让 tree 过滤.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explorerTreeItem } from './helpers/explorer';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForTestHooks } from './helpers/app-ready';

test('Cmd+P 列表含 .secret.md(虽 tree 不显)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qodot-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qodot-ws-'));
  try {
    writeFileSync(path.join(ws, '.secret.md'), '# secret\n');
    writeFileSync(path.join(ws, 'visible.txt'), 'x\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 关掉 showHiddenFiles → Tree 不显 .secret.md:先等树渲染出 visible.txt 再断言
    await expect(explorerTreeItem(win, /^visible\.txt$/)).toBeVisible({ timeout: 10_000 });
    await waitForTestHooks(win);
    await win.evaluate(() => globalThis.__continuoTest!.setSettingValue('explorer.showHiddenFiles', false));
    await expect(
      win.locator('[role=treeitem]').filter({ hasText: /^\.secret\.md$/ }),
    ).toHaveCount(0, { timeout: 5_000 });

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible();
    await expect(win.locator('.wm-modal-content')).toContainText(
      'visible.txt',
      { timeout: 10_000 },
    );

    // 输 secret → 列出 .secret.md
    await input.fill('secret');
    await expect(
      win.locator('.wm-modal-content li').first(),
    ).toContainText('.secret.md');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

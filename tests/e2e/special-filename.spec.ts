// 文件名含空格/中文 → tree 显示 + 单击打开 + header 显原名.  @edge
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('我的笔记.md / with space.txt 都可打开', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sf-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sf-ws-'));
  try {
    writeFileSync(path.join(ws, '我的笔记.md'), '# zh\n');
    writeFileSync(path.join(ws, 'with space.txt'), 'spaced\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 点中文文件
    await win.locator('text=我的笔记.md').first().click();
    await expect(win.locator('header').first()).toContainText('我的笔记.md', {
      timeout: 10_000,
    });

    // 点空格文件
    await win.locator('text=with space.txt').first().click();
    await expect(win.locator('header').first()).toContainText(
      'with space.txt',
    );

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

// 深层目录展开:src/sub1/sub2/leaf.ts → 逐级展开 + 可单击打开.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandTreeItem, explorerTreeItem, openTreeItem } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('深 3 层目录:逐级展开 + 打开 leaf.ts', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-deep-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-deep-ws-'));
  try {
    mkdirSync(path.join(ws, 'src/sub1/sub2'), { recursive: true });
    writeFileSync(path.join(ws, 'src/sub1/sub2/leaf.ts'), 'export const leaf = true;\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await expandTreeItem(win, /^src$/);
    await expect(explorerTreeItem(win, /^sub1$/)).toBeVisible({
      timeout: 10_000,
    });
    await expandTreeItem(win, /^sub1$/);
    await expect(explorerTreeItem(win, /^sub2$/)).toBeVisible({
      timeout: 10_000,
    });
    await expandTreeItem(win, /^sub2$/);
    await expect(explorerTreeItem(win, /^leaf\.ts$/)).toBeVisible({
      timeout: 10_000,
    });

    // 单击 leaf.ts → editor 打开
    await openTreeItem(win, /^leaf\.ts$/);
    await expect(win.locator('header').first()).toContainText('leaf.ts', {
      timeout: 10_000,
    });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

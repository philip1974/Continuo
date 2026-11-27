// 资源管理器按 VSCode 默认排序:目录优先、名字里的数字按数值比(file-2 在 file-10 前)。
// BDD: src/__tests__/explorer-natural-sort/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { explorerTreeItem } from './helpers/explorer';

test('file-1 / file-2 / file-10 / file-20 按数值排序,目录 ch2 / ch10 在前', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'nsort-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'nsort-ws-'));
  for (const n of ['file-10.txt', 'file-2.txt', 'file-20.txt', 'file-1.txt']) writeFileSync(path.join(ws, n), '');
  mkdirSync(path.join(ws, 'ch10'));
  mkdirSync(path.join(ws, 'ch2'));
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(explorerTreeItem(win, /^file-20\.txt$/)).toBeVisible({ timeout: 10_000 });
    const order = ['ch2', 'ch10', 'file-1.txt', 'file-2.txt', 'file-10.txt', 'file-20.txt'];
    const ys: number[] = [];
    for (const n of order) {
      const box = await explorerTreeItem(win, new RegExp(`^${n.replace(/\./g, '\\.')}$`)).boundingBox();
      expect(box, n).not.toBeNull();
      ys.push(box!.y);
    }
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  } finally {
    await closeDiscardingUnsaved(app).catch(() => undefined);
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

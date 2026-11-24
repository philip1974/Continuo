// explorer.json 中 explorer.sort 可解析、hydrate 不报错 + 文件树正常渲染.
// 排序尚未接到树上(explorer.store 的 sort 是预留脚手架,FolderTree 直接用 listDir 顺序),故不断言顺序.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandTreeItem, explorerTreeItem } from './helpers/explorer';
import { launchContinuo } from './helpers/launch';

test('explorer.sort=mtime+reverse 可解析 → 文件树正常渲染(排序尚未实现)', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sort-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sort-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), '1');
    writeFileSync(path.join(ws, 'src/b.ts'), '2');
    writeFileSync(path.join(ws, 'src/c.ts'), '3');
    // 强制 mtime 顺序:c 最新, b 中, a 最老
    const now = Date.now() / 1000;
    utimesSync(path.join(ws, 'src/a.ts'), now - 100, now - 100);
    utimesSync(path.join(ws, 'src/b.ts'), now - 50, now - 50);
    utimesSync(path.join(ws, 'src/c.ts'), now, now);

    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws, path.join(ws, 'src')],
          // 按 mtime 倒序(最新在前)
          sort: { by: 'mtime', reverse: true },
        },
        pinned: { paths: [] },
      }),
    );

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 等 src 行渲染
    await expandTreeItem(win, /^src$/);
    // 等 a.ts 出现
    await expect(explorerTreeItem(win, /^a\.ts$/)).toBeVisible({
      timeout: 10_000,
    });

    // 排序尚未接到树上:只验证三个文件都已渲染.
    await expect(explorerTreeItem(win, /^a\.ts$/)).toBeVisible();
    await expect(explorerTreeItem(win, /^b\.ts$/)).toBeVisible();
    await expect(explorerTreeItem(win, /^c\.ts$/)).toBeVisible();

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

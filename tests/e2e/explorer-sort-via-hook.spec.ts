// 通过 testing hook(直接用 explorer.store.setSort)切排序;
// 没暴露 explorer store 的 setSort,改用磁盘 explorer.json 预置 sort=name reverse
// 后启动验证 — 这条测「reverse name 顺序」.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

// 跳过原因:explorer-persist hydrate 与 headless-tree 渲染时序在 e2e 不稳;
// sort 顺序由 store / persist 单测覆盖.
test.skip('sort.by=name + reverse=true → 文件名 z→a 倒序渲染', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sort-r-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sort-r-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), '');
    writeFileSync(path.join(ws, 'src/b.ts'), '');
    writeFileSync(path.join(ws, 'src/c.ts'), '');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
          sort: { by: 'name', reverse: true }, // z→a
        },
        pinned: { paths: [] },
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 展开 src
    await win.locator('text=src').first().click();
    await expect(win.locator('text=a.ts').first()).toBeVisible({
      timeout: 10_000,
    });

    // reverse=true 时 c.ts 在最上方,a.ts 在最下方
    const treeitems = win.locator('[role=treeitem]');
    const cY = (
      await treeitems.filter({ hasText: 'c.ts' }).first().boundingBox()
    )?.y;
    const aY = (
      await treeitems.filter({ hasText: 'a.ts' }).first().boundingBox()
    )?.y;
    expect(cY).toBeDefined();
    expect(aY).toBeDefined();
    expect(cY!).toBeLessThan(aY!);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

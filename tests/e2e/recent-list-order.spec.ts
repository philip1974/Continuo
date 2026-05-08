// recentRoots [ws1, ws2, ws3] + root=ws1 → ⋯ 「打开最近」 ws2 在 ws3 前(LRU 顺序).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('recentRoots [ws1, ws2, ws3] → 菜单 ws2 出现在 ws3 之前', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rlo-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-rlo-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-rlo-ws2-'));
  const ws3 = mkdtempSync(path.join(tmpdir(), 'continuo-rlo-ws3-'));
  try {
    writeFileSync(path.join(ws1, 'a.md'), '# 1\n');
    writeFileSync(path.join(ws2, 'b.md'), '# 2\n');
    writeFileSync(path.join(ws3, 'c.md'), '# 3\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1, ws2, ws3] },
        explorer: {
          activePath: null,
          expandedPaths: [ws1],
          sort: { by: 'name', reverse: false },
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

    await win.locator('button[aria-label=更多操作]').click();
    const menu = win.getByRole('menu');
    await expect(menu).toBeVisible();

    // 菜单内 menuitem 顺序:展开全部 → ws2 → ws3 → 切换 → 关闭
    // 验 ws2 出现在 ws3 之前
    const items = await menu.getByRole('menuitem').allTextContents();
    const ws2Name = path.basename(ws2);
    const ws3Name = path.basename(ws3);
    const ws2Idx = items.findIndex((s) => s.includes(ws2Name));
    const ws3Idx = items.findIndex((s) => s.includes(ws3Name));
    expect(ws2Idx).toBeGreaterThan(-1);
    expect(ws3Idx).toBeGreaterThan(-1);
    expect(ws2Idx).toBeLessThan(ws3Idx);

    // 当前 ws1 不在 list(filtered)
    const ws1Name = path.basename(ws1);
    expect(items.some((s) => s.includes(ws1Name))).toBe(false);

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ws3, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

// 老版本 explorer.json 缺 layoutUi 字段(向下兼容)→ 用 store 默认值
// (sidebarOpen=true, sidebarWidth=280).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('explorer.json 缺 layoutUi → sidebarOpen=true + width=280(默认)', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-no-lui-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-no-lui-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
    // 不写 layoutUi 字段
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
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

    // sidebar 默认 open + width 280
    const sidebar = win.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible();
    await expect
      .poll(async () =>
        sidebar.evaluate((el: HTMLElement) => el.style.width),
      )
      .toBe('280px');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

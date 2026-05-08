// 侧栏宽度从 explorer.json 的 layoutUi 字段 hydrate.
//
// 注:本测试只验证 hydrate 一侧(layoutUi.sidebarWidth=420 → aside style.width=420px),
// 而非拖拽 → 写回流程。拖拽走 useColumnResize 的 native mousemove,Playwright 在
// dockview-react 的边界处难稳定模拟;真行为已被 use-column-resize 单测覆盖.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('explorer.json 的 layoutUi.sidebarWidth → aside style.width', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sb-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sb-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
    // 预置 sidebarWidth=420
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
        layoutUi: { sidebarOpen: true, sidebarWidth: 420 },
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const sidebar = win.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible();
    // hydrate 是 fire-and-forget,等 store setState 触发重渲
    await expect
      .poll(async () =>
        sidebar.evaluate((el: HTMLElement) => el.style.width),
      )
      .toBe('420px');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

test('explorer.json 的 layoutUi.sidebarOpen=false → aside 不渲染', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sb-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sb-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
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
        layoutUi: { sidebarOpen: false, sidebarWidth: 280 },
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 只剩 IconSidebar(48px),没有 ExplorerSidebar
    await expect.poll(async () => win.locator('main aside').count()).toBe(1);
    // StatusBar 出现「侧栏已隐藏」
    await expect(win.locator('footer')).toContainText('侧栏已隐藏');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

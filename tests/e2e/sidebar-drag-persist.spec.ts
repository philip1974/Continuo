// 拖拽 sidebar 改宽度 → debounce → explorer.json layoutUi.sidebarWidth 写盘.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dragSidebarResize } from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('拖拽 sidebar → width 写盘 + 重启复原', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-drag-persist-'));
  try {
    // ── 第一次启动:拖拽 ──
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    const sidebar = win1.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible();
    // 拖右移 50px,新 width = 280 + 50 = 330
    await dragSidebarResize(win1, 50);

    await expect
      .poll(async () => sidebar.evaluate((el: HTMLElement) => el.style.width))
      .toBe('330px');

    await app1.close();

    const raw = readFileSync(path.join(ud, 'explorer.json'), 'utf8');
    const data = JSON.parse(raw) as {
      layoutUi?: { sidebarWidth?: number };
      windows?: Array<{ layoutUi?: { sidebarWidth?: number } }>;
    };
    expect(data.windows?.[0]?.layoutUi?.sidebarWidth ?? data.layoutUi?.sidebarWidth).toBe(330);

    // ── 第二次启动:复原 ──
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    const sidebar2 = win2.locator('main aside').nth(1);
    await expect(sidebar2).toBeVisible();
    await expect
      .poll(async () => sidebar2.evaluate((el: HTMLElement) => el.style.width))
      .toBe('330px');
    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

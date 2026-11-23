// 首次启动:userData 中没有 explorer.json → 应用使用默认值、不抛页面错误.
import { _electron as electron, expect, test } from '@playwright/test';
import { EXPLORER_NO_FOLDER_OPEN } from './helpers/explorer';
import { waitForAppReady } from './helpers/app-ready';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('fresh userData(无 explorer.json)→ EmptyWorkspace + 默认值不抛', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-fresh-'));
  try {
    // 启动前确认 explorer.json 不存在
    expect(existsSync(path.join(ud, 'explorer.json'))).toBe(false);

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    const pageErrors: string[] = [];
    win.on('pageerror', (err) => pageErrors.push(err.message));
    await win.waitForLoadState('domcontentloaded');
    await waitForAppReady(win);

    // 默认 → EmptyWorkspace
    await expect(win.getByText(EXPLORER_NO_FOLDER_OPEN)).toBeVisible({
      timeout: 10_000,
    });
    // sidebar 默认 open + width 280
    const sidebar = win.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible();
    expect(
      await sidebar.evaluate((el: HTMLElement) => el.style.width),
    ).toBe('280px');
    expect(pageErrors).toEqual([]);

    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

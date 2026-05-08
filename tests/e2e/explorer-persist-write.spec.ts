// 改 store(切 sidebar)→ debounce 300ms → explorer.json 写盘 + 内容验证.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('关 sidebar → 等 debounce → explorer.json layoutUi.sidebarOpen=false', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-persist-write-'));
  try {
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 关 sidebar(默认 open)
    await win.locator('button[title="隐藏 Explorer"]').click();
    // 等 debounce 300ms + IPC 写
    await win.waitForTimeout(800);

    // 读磁盘 explorer.json
    const raw = readFileSync(path.join(ud, 'explorer.json'), 'utf8');
    const data = JSON.parse(raw) as {
      layoutUi?: { sidebarOpen?: boolean };
    };
    expect(data.layoutUi?.sidebarOpen).toBe(false);

    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

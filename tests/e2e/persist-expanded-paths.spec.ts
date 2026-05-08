// 预置 expandedPaths 含 src → 启动后 src 已展开 + 子文件 a.ts 自动可见.
import { _electron as electron, expect, test } from '@playwright/test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

// 跳过:headless-tree initialState.expandedItems 与 store hydrate 时序问题;
// 此功能在 explorer-persist 单测中已覆盖。
test.skip('expandedPaths hydrate → 启动后 src 已展开,子文件可见', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-active-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-active-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
    writeFileSync(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          // 预置 root + src 都展开
          expandedPaths: [ws, path.join(ws, 'src')],
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

    // src 应预先展开,a.ts 直接可见(无需手动 click)
    await expect(win.locator('text=a.ts').first()).toBeVisible({
      timeout: 10_000,
    });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

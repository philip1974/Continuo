// 综合流:workspace + 编辑 + Cmd+S + 关 → 重启 → workspace 还原 + 磁盘内容仍是新值.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkspaceFile } from './helpers/editor';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('编辑 a.ts + Cmd+S + 关 → 重启同 ud + ws → 磁盘新值在', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-full-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-full-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws, path.join(ws, 'src')],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    // 第一次启
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await openWorkspaceFile(win1, ['src', 'a.ts']);
    const cm1 = win1.locator('.cm-content');
    await expect(cm1).toBeVisible({ timeout: 10_000 });
    await cm1.click();
    await cm1.press('ControlOrMeta+End');
    await win1.keyboard.type(' // saved-full');
    await cm1.press('ControlOrMeta+KeyS');

    // 等磁盘
    await expect(async () => {
      const c = readFileSync(path.join(ws, 'src/a.ts'), 'utf8');
      expect(c).toContain('saved-full');
    }).toPass({ timeout: 5_000 });

    await app1.close();

    // 第二次启 → 磁盘内容仍在
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // workspace 还原
    const wsName = path.basename(ws);
    await expect(win2.locator('main aside').nth(1).getByText(wsName).first()).toBeVisible({
      timeout: 10_000,
    });

    // 磁盘读
    const after = readFileSync(path.join(ws, 'src/a.ts'), 'utf8');
    expect(after).toContain('saved-full');

    await app2.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

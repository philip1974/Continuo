// 空 workspace + Cmd+P → 模态打开 + 列表 0 项.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const QO_EMPTY = /(工作区无文件|No files in workspace|워크스페이스에 파일이 없습니다)/;
const QO_NO_WORKSPACE = /(请先在 Explorer 打开工作区|Please open a workspace in Explorer first|먼저 Explorer에서 워크스페이스를 여세요)/;

test('空 ws + Cmd+P → modal 显占位 + 0 li', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qo-empty-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qo-empty-ws-'));
  try {
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

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible({ timeout: 5_000 });

    // 显示「工作区无文件」(而非「请先打开工作区」:后者是 root 尚未恢复时的占位),再断言 0 li
    await expect(win.locator('.wm-modal-content')).toContainText(QO_EMPTY, { timeout: 10_000 });
    await expect(win.locator('.wm-modal-content')).not.toContainText(QO_NO_WORKSPACE);
    await expect(win.locator('.wm-modal-content li')).toHaveCount(0);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

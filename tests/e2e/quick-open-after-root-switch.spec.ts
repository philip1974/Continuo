// 切 root 后,Cmd+P 应列出新 workspace 的文件,不再显旧 root 的文件.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPLORER_MORE_ACTIONS } from './helpers/explorer';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('切 root → Cmd+P 列新 workspace 文件', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qo-rs-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-qo-rs-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-qo-rs-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'README-WS1.md'), '# ws1\n');
    writeFileSync(path.join(ws1, 'src/old.ts'), 'old\n');
    writeFileSync(path.join(ws2, 'CHANGELOG-WS2.md'), '# ws2\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1, ws2] },
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

    const wsName2 = path.basename(ws2);
    // 等 ws1 渲染
    await expect(win.locator('text=README-WS1.md')).toBeVisible({
      timeout: 10_000,
    });

    // 切 root → ws2
    await win
      .locator('main aside')
      .nth(1)
      .getByRole('button', { name: EXPLORER_MORE_ACTIONS })
      .click();
    await win.getByRole('menuitem', { name: wsName2, exact: false }).click();
    await expect(win.locator('text=CHANGELOG-WS2.md')).toBeVisible({
      timeout: 10_000,
    });

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible({ timeout: 5_000 });

    // 等 walk
    await expect(win.locator('.wm-modal-content')).toContainText(
      'CHANGELOG-WS2.md',
      { timeout: 10_000 },
    );
    // 不含 ws1 文件
    const text = (
      await win.locator('.wm-modal-content li').allTextContents()
    ).join('\n');
    expect(text).not.toContain('README-WS1.md');
    expect(text).not.toContain('old.ts');

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

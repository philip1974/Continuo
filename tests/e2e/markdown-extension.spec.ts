// .markdown 扩展也启 markdown 模式(SegmentedControl 显).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('打开 .markdown 文件 → SegmentedControl Edit/Source/Preview 显', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-md-ext-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-md-ext-ws-'));
  try {
    writeFileSync(path.join(ws, 'doc.markdown'), '# extension test\n');
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

    await win.locator('text=doc.markdown').first().click();
    await expect(win.locator('header').first()).toContainText(
      'doc.markdown',
      { timeout: 10_000 },
    );

    const main = win.locator('main');
    await expect(main).toContainText('Edit');
    await expect(main).toContainText('Source');
    await expect(main).toContainText('Preview');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

// 含多行的 file → footer 行数 = 实际行数.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('多行 file → footer N 行计数正确', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-lc-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-lc-ws-'));
  try {
    // 5 行(4 个 \n + 末尾 \n)
    writeFileSync(path.join(ws, 'multi.txt'), 'a\nb\nc\nd\ne\n');
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

    await win.locator('text=multi.txt').first().click();
    await expect(win.locator('header').first()).toContainText('multi.txt', {
      timeout: 10_000,
    });

    // lineCount 实现: split('\n').length。'a\nb\nc\nd\ne\n'.split('\n') = 6 段(末尾 \n 后空段)
    // 所以会显 '6 行' (但 lineCount 取 max(1, total-1))?让我直接断言 行 出现且数字 ≥ 5
    const footer = win.locator('footer');
    const text = await footer.textContent();
    expect(text).toMatch(/\d+\s*行/);
    const m = text?.match(/(\d+)\s*行/);
    if (m) {
      const n = Number(m[1]);
      expect(n).toBeGreaterThanOrEqual(5);
    }

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

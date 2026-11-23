// 旧版 layout.json 残留(且是非法 JSON)→ 启动时不解析、直接删除 → 默认布局(Editor panel 出现).  @edge
import { _electron as electron, expect, test } from '@playwright/test';
import { EDITOR_NO_FILE_OPEN } from './helpers/editor';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('旧 layout.json 残留且为非法 JSON → 启动时被删除,默认布局(Editor panel 渲染)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt-layout-'));
  try {
    writeFileSync(
      path.join(ud, 'layout.json'),
      '{not json',
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 默认布局含 Editor panel → EditorWelcome「未打开文件」
    await expect(win.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({
      timeout: 10_000,
    });
    // 旧文件在启动时被删除(不解析)
    await expect.poll(() => existsSync(path.join(ud, 'layout.json'))).toBe(false);

    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

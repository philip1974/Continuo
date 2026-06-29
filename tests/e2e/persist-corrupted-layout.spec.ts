// layout.json 损坏 → fromJSON 失败 → fallback 默认布局(Editor panel 出现).  @edge
import { _electron as electron, expect, test } from '@playwright/test';
import { EDITOR_NO_FILE_OPEN } from './helpers/editor';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('layout.json 是垃圾 JSON → fallback 默认布局(Editor panel 渲染)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-corrupt-layout-'));
  try {
    writeFileSync(
      path.join(ud, 'layout.json'),
      JSON.stringify({ totallyInvalid: 'shape' }),
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

    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

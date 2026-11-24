// 含中文 / emoji / 多字节字符的 file → CM 正确显示.  @edge
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('Unicode/中文/emoji file → CM 正确显示', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-uni-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-uni-ws-'));
  try {
    writeFileSync(
      path.join(ws, 'unicode.txt'),
      '你好世界 🌍\nこんにちは 🇯🇵\n한국어 ✨\n',
    );
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.locator('text=unicode.txt').first().click();
    const cm = win.locator('.cm-content').first();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await expect(cm).toContainText('你好世界');
    await expect(cm).toContainText('한국어');
    await expect(cm).toContainText('🌍');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

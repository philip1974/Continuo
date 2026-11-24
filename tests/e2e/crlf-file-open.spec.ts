// 含 CRLF 行尾的 file 打开不崩 + footer 显行数.  @edge
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statusLines } from './helpers/status-bar';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('CRLF file → 打开不崩 + footer 显行数', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-crlf-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-crlf-ws-'));
  try {
    writeFileSync(
      path.join(ws, 'win.txt'),
      'line1\r\nline2\r\nline3\r\n',
    );
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.locator('text=win.txt').first().click();
    await expect(win.locator('header').first()).toContainText('win.txt', {
      timeout: 10_000,
    });

    // CodeMirror 渲 + footer 行数显示
    await expect(win.locator('.cm-content').first()).toBeVisible();
    // 'line1\r\nline2\r\nline3\r\n':3 个 \n → 4 行(尾部换行算下一空行,CRLF 只计 \n)
    await expect(win.locator('footer')).toContainText(statusLines(4));

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

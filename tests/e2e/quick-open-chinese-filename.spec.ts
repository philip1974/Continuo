// Cmd+P 输中文 → 匹配中文文件名.
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('Cmd+P 输 笔记 → 列出 我的笔记.md', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qzh-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qzh-ws-'));
  try {
    writeFileSync(path.join(ws, '我的笔记.md'), '# x\n');
    writeFileSync(path.join(ws, 'other.txt'), 'x\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible();
    await expect(win.locator('.wm-modal-content')).toContainText(
      '我的笔记.md',
      { timeout: 10_000 },
    );

    await input.fill('笔记');
    await expect(
      win.locator('.wm-modal-content li').first(),
    ).toContainText('我的笔记.md');
    // other.txt 不匹配
    const text = (
      await win.locator('.wm-modal-content li').allTextContents()
    ).join('\n');
    expect(text).not.toContain('other.txt');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

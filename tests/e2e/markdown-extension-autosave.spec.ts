// .markdown 扩展 isAutoSaveEnabled=true → autoSave 防抖后写(delayMs 被钳到 500ms 下限).
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

test('doc.markdown + delay=0(钳到 500ms)+ setEditorContent → 防抖后写盘', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-mdas-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-mdas-ws-'));
  try {
    writeFileSync(path.join(ws, 'doc.markdown'), '# v1\n');
    seedExplorerJson(ud, { root: ws });

    const app = await launchContinuo(ud);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown })
            .__continuoTest,
        ),
      { timeout: 5_000 },
    );
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: { setSettingValue: (id: string, v: number) => void };
        }
      ).__continuoTest;
      t.setSettingValue('autoSave.delayMs', 0);
    });

    await win.locator('text=doc.markdown').first().click();
    await expect(win.locator('header').first()).toContainText('doc.markdown', {
      timeout: 10_000,
    });

    const tabId = await win.evaluate(
      () =>
        (
          window as unknown as {
            __continuoTest: { getEditorActiveTabId: () => string | null };
          }
        ).__continuoTest.getEditorActiveTabId(),
    );
    expect(tabId).toBeTruthy();

    const NEW = '# auto-saved markdown ext\n';
    await win.evaluate(
      ({ tabId, content }) => {
        (
          window as unknown as {
            __continuoTest: {
              setEditorContent: (id: string, c: string) => void;
            };
          }
        ).__continuoTest.setEditorContent(tabId as string, content);
      },
      { tabId, content: NEW },
    );

    // delay=0 被钳到 500ms → 防抖后写盘
    await expect(async () => {
      const onDisk = readFileSync(path.join(ws, 'doc.markdown'), 'utf8');
      expect(onDisk).toBe(NEW);
    }).toPass({ timeout: 2_000 });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

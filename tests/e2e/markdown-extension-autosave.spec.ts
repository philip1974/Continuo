// .markdown 扩展 isAutoSaveEnabled=true → autoSave 立即写.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('doc.markdown + delay=0 + setEditorContent → 立即写盘', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-mdas-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-mdas-ws-'));
  try {
    writeFileSync(path.join(ws, 'doc.markdown'), '# v1\n');
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

    // delay=0 → 立即写盘
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

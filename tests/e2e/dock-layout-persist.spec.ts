import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OUTPUT_EMPTY } from './helpers/output';
import { launchContinuo } from './helpers/launch';
import { waitForTestHooks } from './helpers/app-ready';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

async function launch(userData: string): Promise<ElectronApplication> {
  return await launchContinuo(userData);
}

async function waitForTestHook(page: Page): Promise<void> {
  await waitForTestHooks(page, 10_000);
}

async function openOutputPanel(page: Page): Promise<void> {
  await waitForTestHook(page);
  // testing hook 可能先于 dock 就绪暴露(此时 openOrFocusPanel 是 no-op):重试到面板出现。
  await expect(async () => {
    await page.evaluate(() => {
      const t = globalThis.__continuoTest!;
      t.openOrFocusPanel('output', 'output', 'Output');
    });
    await expect(page.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

// 与其它 e2e 一样,运行时不能同时开着打包版 Continuo(macOS NSApplication 注册会中止 Playwright 的 Electron 启动)。
test.describe('dock-layout-per-window-seq: v3 persist roundtrip', () => {
  let userData: string;
  let explorerFile: string;
  let legacyLayoutFile: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    userData = await mkdtemp(path.join(tmpdir(), 'continuo-e2e-08-'));
    explorerFile = path.join(userData, 'explorer.json');
    legacyLayoutFile = path.join(userData, 'layout.json');
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } catch {
      // ignore cleanup failures
    }
    app = null;
    await rm(userData, { recursive: true, force: true });
  });

  test('legacy layout.json is removed while explorer.json is migrated to v3 on first boot', async () => {
    test.setTimeout(60_000);
    await writeFile(
      explorerFile,
      JSON.stringify({
        version: 2,
        workspace: { recentRoots: [] },
        pinned: { paths: [] },
        nextWindowSeq: 1,
        windows: [
          {
            windowSeq: 0,
            workspace: { root: null },
            explorer: {
              activePath: null,
              expandedPaths: [],
              sort: { by: 'name', reverse: false },
            },
          },
        ],
      }),
      'utf-8',
    );
    await writeFile(
      legacyLayoutFile,
      JSON.stringify({ version: 1, dummy: 'legacy' }),
      'utf-8',
    );

    app = await launch(userData);
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect
      .poll(async () => {
        const migrated = ((await fileExists(explorerFile)) ? await readJson(explorerFile) : {}) as { version?: number };
        return {
          version: migrated.version,
          legacyExists: await fileExists(legacyLayoutFile),
        };
      })
      .toEqual({ version: 3, legacyExists: false });

    await app.close();
    app = null;
  });

  test('Output panel layout persists in explorer.json v3 and restores after restart', async () => {
    test.setTimeout(90_000);

    app = await launch(userData);
    const page1 = await app.firstWindow();
    await page1.waitForLoadState('domcontentloaded');

    await openOutputPanel(page1);

    await expect
      .poll(async () => {
        // 首次写盘前文件尚不存在:按空对象继续轮询
        const persisted = ((await fileExists(explorerFile)) ? await readJson(explorerFile) : {}) as {
          version?: number;
          windows?: Array<{ windowSeq?: number; layout?: unknown }>;
        };
        const layoutText = JSON.stringify(persisted.windows?.[0]?.layout ?? {});
        return {
          version: persisted.version,
          windowSeq: persisted.windows?.[0]?.windowSeq,
          hasOutput: layoutText.includes('output'),
        };
      })
      .toEqual({ version: 3, windowSeq: 0, hasOutput: true });

    expect(await fileExists(legacyLayoutFile)).toBe(false);

    await app.close();
    app = null;

    const persisted = (await readJson(explorerFile)) as {
      version?: number;
      windows?: Array<{ windowSeq?: number; layout?: unknown }>;
    };
    expect(persisted.version).toBe(3);
    expect(persisted.windows).toHaveLength(1);
    expect(persisted.windows?.[0]?.windowSeq).toBe(0);
    expect(JSON.stringify(persisted.windows?.[0]?.layout ?? {})).toContain(
      'output',
    );

    app = await launch(userData);
    const page2 = await app.firstWindow();
    await page2.waitForLoadState('domcontentloaded');

    // 默认布局不含 Output panel:它在重启后出现即证明布局已从 explorer.json 恢复
    await expect(page2.getByText(OUTPUT_EMPTY)).toBeVisible({
      timeout: 15_000,
    });

    await app.close();
    app = null;
  });
});

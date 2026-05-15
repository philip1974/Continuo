import {
  _electron as electron,
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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

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
  return await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
  });
}

async function waitForTestHook(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 10_000 },
  );
}

async function openOutputPanel(page: Page): Promise<void> {
  await waitForTestHook(page);
  await page.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          openOrFocusPanel: (id: string, c: string, t: string) => void;
        };
      }
    ).__continuoTest;
    t.openOrFocusPanel('output', 'output', 'Output');
  });
  await expect(page.locator('text=Continuo ready')).toBeVisible({
    timeout: 10_000,
  });
}

// Requires no other Continuo instance running. When packaged Continuo is open,
// macOS NSApplication registration aborts the Playwright Electron launch before
// the test body runs; existing e2e specs have the same limitation.
test.describe.skip('dock-layout-per-window-seq: v3 persist roundtrip', () => {
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
        const migrated = (await readJson(explorerFile)) as { version?: number };
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
        const persisted = (await readJson(explorerFile)) as {
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

    await expect(page2.locator('text=Continuo ready')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page2.locator('text=dock layout restored')).toBeVisible();

    await app.close();
    app = null;
  });
});

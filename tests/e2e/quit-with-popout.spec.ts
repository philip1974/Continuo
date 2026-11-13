// 有 popout 窗口时退出:不因 popout 窗口(跑 PopoutHost,不应答关窗 flush)而多等 10s 的 flush 回执超时。
//
// dockview 的 addPopoutGroup 在 Playwright 控制的 Electron 下不稳定(见 popout-window.spec.ts),这里
// 直接用 window.open 打开 popout URL —— 走的是同一个 windowOpenHandler(受信 renderer 入口 → 允许 +
// 注入 preload),main 侧看到的是同一种 popout 窗口。
//
// 进程退出耗时受机器负载影响很大(Chromium 自身的收尾),所以不设绝对上限:同一次运行里先量一个
// 「没有 popout」的退出耗时作基线,带 popout 的退出不得比它多出一个 flush 超时(10s)的量级。
import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const SETTINGS = /^(设置|Settings|설정)$/;
const FLUSH_ACK_TIMEOUT_MS = 10_000;

async function launch(): Promise<{ app: ElectronApplication; main: Page; dispose: () => void }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-popout-quit-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
  });
  const main = await app.firstWindow();
  await expect(main.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 15_000 });
  return { app, main, dispose: () => rmSync(userDataDir, { recursive: true, force: true }) };
}

async function timedClose(app: ElectronApplication): Promise<number> {
  const startedAt = Date.now();
  await app.close();
  return Date.now() - startedAt;
}

test('主窗 + popout 窗口同时存在 → popout 能打开,退出不多等一个 flush 超时', async () => {
  test.setTimeout(120_000);

  const baseline = await launch();
  const baselineMs = await timedClose(baseline.app);
  baseline.dispose();

  const { app, main, dispose } = await launch();
  try {
    const opened = await main.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('popout', '1');
      return window.open(url.toString()) !== null;
    });
    expect(opened).toBe(true);
    await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(2);
    const popout = app.windows().find((w) => w !== main)!;
    await expect(popout.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });

    const withPopoutMs = await timedClose(app);
    expect(withPopoutMs).toBeLessThan(baselineMs + FLUSH_ACK_TIMEOUT_MS - 2_000);
  } finally {
    await app.close().catch(() => undefined);
    dispose();
  }
});

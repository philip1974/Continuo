// 有 popout 窗口时退出:不因 popout 窗口(跑 PopoutHost,不应答关窗 flush)而多等 10s 的 flush 回执超时。
//
// dockview 的 addPopoutGroup 在 Playwright 控制的 Electron 下不稳定(见 popout-window.spec.ts),这里
// 直接用 window.open 打开 popout URL —— 走的是同一个 windowOpenHandler(受信 renderer 入口 → 允许 +
// 注入 preload),main 侧看到的是同一种 popout 窗口。
//
// 不量整个进程的退出耗时:will-quit 之后 Chromium 原生收尾偶有数十秒抖动(见 doc/follow-ups.md),与应用
// 逻辑无关,会让基于墙钟的断言偶发误报。改为直接断言主进程 CONTINUO_E2E 下的退出打点:flush 只发给主窗
//(popout 不在 flush 目标内),且 flush 阶段远低于一个回执超时(10s)。
import { test, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const SETTINGS = /^(设置|Settings|설정)$/;
const FLUSH_ACK_TIMEOUT_MS = 10_000;

async function launch(): Promise<{
  app: ElectronApplication;
  main: Page;
  stdout: () => string;
  dispose: () => void;
}> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-popout-quit-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
  });
  let out = '';
  app.process().stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  const main = await app.firstWindow();
  await expect(main.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 15_000 });
  return { app, main, stdout: () => out, dispose: () => rmSync(userDataDir, { recursive: true, force: true }) };
}

test('主窗 + popout 窗口同时存在 → popout 能打开,退出不多等一个 flush 超时', async () => {
  test.setTimeout(120_000);

  const { app, main, stdout, dispose } = await launch();
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

    await app.close();
    const log = stdout();
    expect(log).toContain('[quit-trace] confirmed (1 windows)');
    const flushed = /\[quit-trace\] flushed: .* \+(\d+)ms/.exec(log);
    expect(flushed, log).not.toBeNull();
    expect(Number(flushed![1])).toBeLessThan(FLUSH_ACK_TIMEOUT_MS / 2);
  } finally {
    await app.close().catch(() => undefined);
    dispose();
  }
});

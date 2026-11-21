// 多 window:同一 userData 启两个 Electron 实例?Continuo 默认 single-instance,
// second-instance 路由到第一个 window。所以无法启两个真实例。
//
// 但可以验证:启第二个时,第一个 window 收到 second-instance 信号(触发 focus + 处理 argv).
// 这个不太好测,改测「连续启 2 次,第二次立即退出」.

import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test.skip('single-instance:第二次启同 userData 不创建新进程(由 main app.requestSingleInstanceLock)', async () => {
  // 跳过原因:Playwright Electron 测试启 process 时不走 single-instance lock 路径
  // (Electron 的 lock 通常在 packaged app 才完整生效;dev 模式 + 测试不可靠).
  // 已记录,真行为留人工 QA.
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-mw-'));
  try {
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    await app1.firstWindow();

    // 第二次:requestSingleInstanceLock 应返 false → app.quit
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
      timeout: 5_000,
    });
    // app2 应该立即退出
    await app2.close();

    // app1 仍存活
    expect(app1.windows().length).toBeGreaterThan(0);
    await app1.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});

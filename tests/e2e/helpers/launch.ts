// e2e 启动 Continuo 的单一入口(fixtures 与需要自管生命周期的用例共用;此前各文件各写一份
// MAIN_ENTRY + launch 参数 / env)。
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

export function launchContinuo(
  userDataDir: string,
  opts: {
    readonly timeout?: number;
    /** 追加 / 覆盖的环境变量(如工作区信任专项 e2e 的 CONTINUO_E2E_WORKSPACE_TRUST=1)。 */
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    // ELECTRON_DISABLE_GPU:让 CI / headless 更稳,本地无副作用;CONTINUO_E2E:main 与 preload 据此启用
    // e2e 行为 / testing helpers。
    // E2E 默认关闭工作区信任(一切受信任、不弹信任对话框,见 electron/main/ipc/workspace-trust.ipc);信任专项 e2e 经
    // opts.env 设 CONTINUO_E2E_WORKSPACE_TRUST=1 打开真实行为。
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1', ...opts.env },
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
  });
}

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
  opts: { readonly timeout?: number } = {},
): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    // ELECTRON_DISABLE_GPU:让 CI / headless 更稳,本地无副作用;CONTINUO_E2E:main 与 preload 据此启用
    // e2e 行为 / testing helpers。DISABLE_AUTO_TITLE:终端 tab 显示程序经 OSC 设的标题(terminal-title),本机
    // oh-my-zsh 每个提示符都会设「user@host: dir」→ 用例按默认名「终端 N」找 tab 会随开发者 dotfiles 变;关掉其自动标题。
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1', DISABLE_AUTO_TITLE: 'true' },
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
  });
}

// 设置值 / 快捷键覆盖的主进程文件(userData/user-settings.json、user-keybindings.json,见
// electron/main/services/user-settings.service)。e2e 直接读盘断言「已持久化」。
import type { ElectronApplication } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const USER_SETTINGS_FILE = 'user-settings.json';
export const USER_KEYBINDINGS_FILE = 'user-keybindings.json';

/** 读盘上的记录;文件不存在 / 不是 JSON → null。 */
export function readUserSettingsFile(
  userDataDir: string,
  file: typeof USER_SETTINGS_FILE | typeof USER_KEYBINDINGS_FILE = USER_SETTINGS_FILE,
): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(userDataDir, file), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 删掉两类记录的文件(模拟旧版本的 userData:只有 localStorage,还没有主进程文件)。 */
export function removeUserSettingsFiles(userDataDir: string): void {
  for (const f of [USER_SETTINGS_FILE, USER_KEYBINDINGS_FILE]) rmSync(path.join(userDataDir, f), { force: true });
}

/** kill -9 本用例启动的主进程(只按它自己的 PID),等它退出。 */
export async function killMainProcess(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGKILL');
  await exited;
}

import type { ElectronApplication } from '@playwright/test';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 关闭 app 并丢弃未保存改动。关窗 / 退出时有未保存改动会弹原生确认框(保存 / 不保存 / 取消),
 * 测试 teardown 无人应答会挂到超时;这里让确认框直接返回「不保存」(下标见
 * electron/main/dirty-close-confirm.ts)再关闭。没有未保存改动时等同于 app.close()。
 */
export async function closeDiscardingUnsaved(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as unknown as typeof dialog.showMessageBox;
    })
    .catch(() => undefined);
  await app.close();
}

/**
 * 把 Electron 主进程 stdout/stderr 持续写入该用例输出目录的 main-process.log(含 CONTINUO_E2E 下的
 * `[quit-trace]` 退出分阶段耗时)。teardown 超时时无法再补写附件,故边产生边落盘,事后据此定位卡在哪一步。
 */
export function captureMainProcessLog(app: ElectronApplication, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  const out = createWriteStream(path.join(outputDir, 'main-process.log'), { flags: 'a' });
  const proc = app.process();
  proc.stdout?.on('data', (chunk: Buffer) => out.write(chunk));
  proc.stderr?.on('data', (chunk: Buffer) => out.write(chunk));
  proc.once('exit', () => out.end());
}

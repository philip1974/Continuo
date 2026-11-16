import type { ElectronApplication } from '@playwright/test';

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

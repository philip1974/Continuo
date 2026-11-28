// 用户设置值 / 快捷键覆盖的 IPC(权威存储见 services/user-settings.service)。
// - SNAPSHOT(同步):renderer 首帧前取两类记录的快照(主题 / 字号首帧即正确);不受信 frame 拿到 null。
// - UPDATE / IMPORT(invoke,safe-handle + zod 限幅):写盘后返回新状态。
// - CHANGED:任一修改提交后广播给所有窗口(替代此前 localStorage 的 storage 事件;popout 子窗由主窗 renderer 驱动,随之更新)。
// BDD: src/__tests__/user-settings-main-store/
import { ipcMain, type IpcMainEvent } from 'electron';
import { z } from 'zod';
import { safeHandle, trustedSenderWindow } from '../safe-handle';
import { broadcastToWindows } from '../lib/broadcast';
import {
  getUserSettingsSnapshot,
  importUserSettings,
  onUserSettingsChanged,
  updateUserSettings,
} from '../services/user-settings.service';
import {
  USER_SETTINGS_CHANNELS,
  USER_SETTINGS_ENTRIES_MAX,
  USER_SETTINGS_KEY_MAX,
  USER_SETTINGS_SCOPES,
  USER_SETTINGS_TEXT_MAX,
  USER_SETTINGS_UPDATE_MAX,
  type UserSettingsChanged,
  type UserSettingsRecord,
} from '../../shared/user-settings';

const Value = z.union([z.string().max(USER_SETTINGS_TEXT_MAX), z.number(), z.boolean()]); // zod 4 的 number 拒 ±Infinity / NaN
const Key = z.string().max(USER_SETTINGS_KEY_MAX);

/** 记录:先按条目数限幅(在逐项校验之前),再逐项校验。 */
function recordSchema(maxEntries: number): z.ZodType<UserSettingsRecord> {
  return z
    .custom<Record<string, unknown>>(
      (v) => {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
        let n = 0;
        for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k) && ++n > maxEntries) return false;
        return true;
      },
      { message: `expected an object with at most ${maxEntries} entries` },
    )
    .pipe(z.record(Key, Value)) as z.ZodType<UserSettingsRecord>;
}

const Scope = z.enum(USER_SETTINGS_SCOPES);

const UpdateInput = z
  .object({
    scope: Scope,
    set: recordSchema(USER_SETTINGS_UPDATE_MAX),
    remove: z.array(Key).max(USER_SETTINGS_UPDATE_MAX),
  })
  .strict();

const ImportInput = z.object({ scope: Scope, record: recordSchema(USER_SETTINGS_ENTRIES_MAX) }).strict();

/** 同步快照通道(与 WINDOW_ID 同为 sendSync,在 index.ts 模块顶层注册,先于任何窗口)。 */
export function registerUserSettingsSnapshotIpc(): void {
  ipcMain.on(USER_SETTINGS_CHANNELS.SNAPSHOT, (event: IpcMainEvent) => {
    event.returnValue = trustedSenderWindow(event) ? getUserSettingsSnapshot() : null;
  });
}

export function registerUserSettingsIpc(): void {
  safeHandle(USER_SETTINGS_CHANNELS.UPDATE, UpdateInput, ({ scope, set, remove }) =>
    updateUserSettings(scope, set, remove),
  );
  safeHandle(USER_SETTINGS_CHANNELS.IMPORT, ImportInput, ({ scope, record }) => importUserSettings(scope, record));
  onUserSettingsChanged((scope, state) => {
    const payload: UserSettingsChanged = { scope, ...state };
    broadcastToWindows(USER_SETTINGS_CHANNELS.CHANGED, () => payload, '[user-settings] CHANGED');
  });
}

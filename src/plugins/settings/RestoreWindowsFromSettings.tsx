// 设置项「启动时恢复所有窗口」(window.restoreWindows)→ main 启动偏好(explorer.json restoreAllWindowsOnLaunch)桥。
// 权威值在 main:启动恢复在任何 renderer 之前就要读到它,localStorage 里的设置值 main 读不到。挂载时与值变化时都推一次
//(main 值未变不写盘):explorer.json 被重置 / 别处改过时,下次打开窗口即重新对齐到设置页显示的值。
// BDD: src/__tests__/restore-windows-on-launch/

import { useEffect, useRef } from 'react';
import { coApi } from '@/lib/co-api';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { useSettingValue } from './values-store';
import { GENERAL_RESTORE_WINDOWS } from './core-setting-specs';

export function RestoreWindowsFromSettings(): null {
  const enabled = useSettingValue<boolean>(GENERAL_RESTORE_WINDOWS.id, GENERAL_RESTORE_WINDOWS.default);
  // 挂载时的那次同步失败只记日志(用户没操作,不弹 toast);用户切换开关后的失败给可见反馈。
  const mounted = useRef(false);
  useEffect(() => {
    const userChange = mounted.current;
    mounted.current = true;
    void Promise.resolve()
      .then(() => coApi.window.setRestoreWindows(enabled))
      .then((r) => {
        if (r.ok) return;
        console.warn('[settings] setRestoreWindows failed', r.code, r.message);
        if (userChange) notifyFailure(r);
      })
      .catch((err: unknown) => {
        console.warn('[settings] setRestoreWindows threw', err);
        if (userChange) notifyThrownError(err);
      });
  }, [enabled]);
  return null;
}

// 设置项「缩放级别」(window.zoomLevel)→ main 桥:main 把级别套用到所有窗口(主窗 / 新窗口 / popout 子窗)并缓存到 userData,
// 冷启动首窗在 renderer 就绪前即按它缩放。挂载时与值变化时都推一次(main 值未变不写盘、不重设):缓存文件缺失 / 被删时,
// 窗口一打开就重新对齐到设置页显示的值。放大 / 缩小 / 重置缩放命令改的也是本设置值(见 shell/window-commands)。
// BDD: src/__tests__/window-zoom/

import { useEffect, useRef } from 'react';
import { coApi } from '@/lib/co-api';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { useSettingValue } from './values-store';
import { WINDOW_ZOOM_LEVEL } from './core-setting-specs';

export function ZoomLevelFromSettings(): null {
  const level = useSettingValue<number>(WINDOW_ZOOM_LEVEL.id, WINDOW_ZOOM_LEVEL.default);
  // 挂载时的那次同步失败只记日志(用户没操作,不弹 toast);之后值变化(设置页 / 缩放命令)的失败给可见反馈。
  const mounted = useRef(false);
  useEffect(() => {
    const userChange = mounted.current;
    mounted.current = true;
    void Promise.resolve()
      .then(() => coApi.window.setZoomLevel(level))
      .then((r) => {
        if (r.ok) return;
        console.warn('[settings] setZoomLevel failed', r.code, r.message);
        if (userChange) notifyFailure(r);
      })
      .catch((err: unknown) => {
        console.warn('[settings] setZoomLevel threw', err);
        if (userChange) notifyThrownError(err);
      });
  }, [level]);
  return null;
}

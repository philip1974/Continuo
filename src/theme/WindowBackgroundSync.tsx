// 把 ThemeProvider 解析出的主题(light / dark;system 已按 OS 解析)与主题模式上报 main,让窗口底色(renderer 绘制前 /
// 缩放与 popout 未绘制区露出的颜色)跟随主题。挂在 ThemeProvider 内(App 顶层,主窗与 popout 宿主各一份)。
// 上报失败只影响未绘制区底色,不打断渲染:只 console.warn。
// BDD: src/__tests__/window-background-theme/

import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { useTheme } from './useTheme';

export function WindowBackgroundSync(): null {
  const { mode, resolved } = useTheme();
  useEffect(() => {
    const warn = (err: unknown) => console.warn('[theme] notify window background failed', err);
    try {
      coApi.window
        .notifyTheme(resolved, mode)
        .then((r) => {
          if (!r.ok) warn(r.code);
        })
        .catch(warn);
    } catch (err) {
      warn(err);
    }
  }, [mode, resolved]);
  return null;
}

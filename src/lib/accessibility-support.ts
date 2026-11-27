// 读屏优化判定(VSCode AccessibilityService.isScreenReaderOptimized):
//   editor.accessibilitySupport === 'on' || ('auto' && 系统检测到辅助技术)。
// 系统检测值来自 main(app.isAccessibilitySupportEnabled() 初值 + 'accessibility-support-changed' 广播),本模块只订阅一次
// (首个使用者出现时惰性启动,应用生命周期内不退订)。popout 子窗的终端与主窗同一 renderer 上下文,共用本状态。
// BDD: src/__tests__/terminal-screen-reader/

import { useSyncExternalStore } from 'react';
import { coApi } from '@/lib/co-api';
import { useSettingValue } from '@/plugins/settings/values-store';
import { EDITOR_ACCESSIBILITY_SUPPORT, type AccessibilitySupport } from '@/plugins/settings/core-setting-specs';

export function isScreenReaderOptimized(setting: AccessibilitySupport, platformEnabled: boolean): boolean {
  return setting === 'on' || (setting === 'auto' && platformEnabled);
}

let platformEnabled = false;
let started = false;
const listeners = new Set<() => void>();

function setPlatformEnabled(next: boolean): void {
  if (next === platformEnabled) return;
  platformEnabled = next;
  for (const l of listeners) l();
}

function start(): void {
  if (started) return;
  started = true;
  // 变化推送先于初值返回 → 初值已过期,丢弃(latest wins)。
  let pushed = false;
  try {
    const api = coApi.accessibility;
    api.onSupportChanged((enabled) => {
      pushed = true;
      setPlatformEnabled(enabled);
    });
    api.getSupport().then(
      (r) => {
        if (!pushed && r.ok) setPlatformEnabled(r.data);
      },
      () => {},
    );
  } catch {
    // 无 preload API(单测 / 旧 mock):按未检测到读屏处理,设置 on 仍可强制。
  }
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): boolean => platformEnabled;

/** 当前是否按读屏优化(设置 + 系统检测),变化时重渲染。 */
export function useScreenReaderOptimized(): boolean {
  const setting = useSettingValue(EDITOR_ACCESSIBILITY_SUPPORT.id, EDITOR_ACCESSIBILITY_SUPPORT.default);
  const platform = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return isScreenReaderOptimized(setting, platform);
}

/** 仅测试:重置模块状态。 */
export function _resetAccessibilitySupportForTest(): void {
  platformEnabled = false;
  started = false;
  listeners.clear();
}

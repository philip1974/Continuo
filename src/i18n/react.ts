import { useSyncExternalStore } from 'react';
import { getLocale, translate, type TranslateParams } from './translate';
import type { Locale } from '@shared/i18n-types';

/**
 * locale 变化订阅 — translate 模块内 setLocale 后通过这里通知 React。
 * 简化方案：用一个 number gen + listener Set；setLocale 时手动 bump（见 settings.store Op5）。
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let gen = 0;

/** settings.store 在调 setLocale 后调本函数，让所有 useT 重渲染。 */
export function notifyLocaleChange(): void {
  gen += 1;
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return gen;
}

/**
 * React hook — 返回当前 locale 的 t 函数；locale 变化时组件 re-render（议题 P0-1）。
 */
export function useT(): (key: string, params?: TranslateParams) => string {
  // 订阅 locale 变化 — return value 不直接用，只用作 re-render 触发器
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // 直接 return translate；模块 currentLocale 永远是最新值
  return translate;
}

/** React 组件需要 locale 本身（如 SegmentedControl active key）时用。 */
export function useLocale(): Locale {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getLocale();
}

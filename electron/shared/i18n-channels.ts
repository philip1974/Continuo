import type { Locale } from './i18n-types';

/**
 * topic 16 i18n IPC channel constants（沿 electron/shared/*-channels.ts 命名风格）。
 *
 * - GET_LOCALE: renderer → main，读当前 locale（同步初值用）
 * - GET_SYSTEM_LOCALE: renderer → main，读系统默认 locale（首启默认；语言设置项的「默认值」）
 * - SET_LOCALE: renderer → main，设置新 locale；main 持久化 + 广播
 * - CHANGED:    main → renderer，广播 locale 变更到所有 BrowserWindow
 */
export const I18N_CHANNELS = {
  GET_LOCALE: 'i18n:get-locale',
  GET_SYSTEM_LOCALE: 'i18n:get-system-locale',
  SET_LOCALE: 'i18n:set-locale',
  CHANGED: 'i18n:changed',
} as const;

/** CHANGED broadcast payload,也是 SET_LOCALE handler 的返回 shape（含 in-flight gen，renderer 可丢弃过期）。 */
export interface I18nChangedPayload {
  readonly locale: Locale;
  readonly gen: number;
}

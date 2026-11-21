/**
 * topic 16 i18n IPC channel constants（沿 electron/shared/*-channels.ts 命名风格）。
 *
 * - GET_LOCALE: renderer → main，读当前 locale（同步初值用）
 * - SET_LOCALE: renderer → main，设置新 locale；main 持久化 + 广播
 * - CHANGED:    main → renderer，广播 locale 变更到所有 BrowserWindow
 */
export const I18N_CHANNELS = {
  GET_LOCALE: 'i18n:get-locale',
  SET_LOCALE: 'i18n:set-locale',
  CHANGED: 'i18n:changed',
} as const;

export type I18nChannel = (typeof I18N_CHANNELS)[keyof typeof I18N_CHANNELS];

/** SET_LOCALE handler 的返回 shape（含 in-flight gen，配合 P1-1）。 */
export interface I18nSetLocaleResult {
  readonly ok: true;
  readonly locale: 'en' | 'zh' | 'ko';
  readonly gen: number;
}

/** CHANGED broadcast payload（含 gen，renderer 可丢弃过期）。 */
export interface I18nChangedPayload {
  readonly locale: 'en' | 'zh' | 'ko';
  readonly gen: number;
}

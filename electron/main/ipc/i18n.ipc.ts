import { BrowserWindow } from 'electron';
import { z } from 'zod';
import { safeHandle, type IsTrustedFrame } from '../safe-handle';
import { I18N_CHANNELS, type I18nSetLocaleResult, type I18nChangedPayload } from '../../shared/i18n-channels';
import { LocaleSchema, type Locale } from '../../shared/i18n-types';
import {
  getCurrentLocale,
  setCurrentLocale,
  getSetLocaleGen,
} from '../services/settings.service';

const NoInput = z.undefined();

// Op9 注册的菜单重建 hook；Op9 之前为 null（IPC 仍能跑，只是不重建菜单）
let menuRebuilder: (() => void) | null = null;
export function setMenuRebuilder(fn: () => void): void {
  menuRebuilder = fn;
}

function broadcastChanged(payload: I18nChangedPayload): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(I18N_CHANNELS.CHANGED, payload);
    }
  }
}

export function registerI18nIpc(trusted: IsTrustedFrame): void {
  safeHandle<undefined, Locale>(
    I18N_CHANNELS.GET_LOCALE,
    NoInput,
    () => getCurrentLocale(),
    trusted,
  );

  safeHandle<Locale, I18nSetLocaleResult>(
    I18N_CHANNELS.SET_LOCALE,
    LocaleSchema,
    async (locale) => {
      const gen = await setCurrentLocale(locale);
      // P1-1: 仅当本调用是最新 gen 才广播/重建（避免乱序）
      if (gen === getSetLocaleGen()) {
        if (menuRebuilder) {
          try {
            menuRebuilder();
          } catch (err) {
            // 重建菜单失败不阻断 locale 同步
            console.error('[i18n] menu rebuild failed', err);
          }
        }
        broadcastChanged({ locale, gen });
      }
      return { ok: true as const, locale, gen };
    },
    trusted,
  );
}

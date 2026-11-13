import { z } from 'zod';
import { safeHandle, type IsTrustedFrame } from '../safe-handle';
import { I18N_CHANNELS, type I18nSetLocaleResult, type I18nChangedPayload } from '../../shared/i18n-channels';
import { LocaleSchema, type Locale } from '../../shared/i18n-types';
import {
  getCurrentLocale,
  setCurrentLocale,
  commitSetLocaleGen,
} from '../services/settings.service';
import { broadcastToWindows } from '../lib/broadcast';

const NoInput = z.undefined();

// Op9 注册的菜单重建 hook；Op9 之前为 null（IPC 仍能跑，只是不重建菜单）
let menuRebuilder: (() => void) | null = null;
export function setMenuRebuilder(fn: () => void): void {
  menuRebuilder = fn;
}

function broadcastChanged(payload: I18nChangedPayload): void {
  // race(R64):此时 locale 已提交到 disk/main;广播失败不得让 SET_LOCALE 返回 ok:false(locale 分裂),
  // 也不得中断其余窗口 —— broadcastToWindows 逐窗口 try/catch。
  broadcastToWindows(I18N_CHANNELS.CHANGED, () => payload, '[i18n] CHANGED');
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
      // setCurrentLocale 写盘失败会上抛 → safeHandle 返回 error,不广播(失败不压掉前一个成功提交)。
      const gen = await setCurrentLocale(locale);
      // race(R36):仅当本次是「最新成功提交」才广播/重建。此前用 getSetLocaleGen()(已发起 gen)判定,
      // 会让「后发起但写盘失败」者压掉「先发起且已成功提交」者的广播 → 其它窗口/菜单停旧语言。
      if (commitSetLocaleGen(gen)) {
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

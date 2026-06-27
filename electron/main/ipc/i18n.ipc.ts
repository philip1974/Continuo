import { BrowserWindow } from 'electron';
import { z } from 'zod';
import { safeHandle, type IsTrustedFrame } from '../safe-handle';
import { I18N_CHANNELS, type I18nSetLocaleResult, type I18nChangedPayload } from '../../shared/i18n-channels';
import { LocaleSchema, type Locale } from '../../shared/i18n-types';
import {
  getCurrentLocale,
  setCurrentLocale,
  commitSetLocaleGen,
} from '../services/settings.service';

const NoInput = z.undefined();

// Op9 注册的菜单重建 hook；Op9 之前为 null（IPC 仍能跑，只是不重建菜单）
let menuRebuilder: (() => void) | null = null;
export function setMenuRebuilder(fn: () => void): void {
  menuRebuilder = fn;
}

function broadcastChanged(payload: I18nChangedPayload): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    // race(R64,R63 同族):isDestroyed() 检查后、send 前窗口可能销毁,send 抛
    // "Object has been destroyed"。此时 locale 已 setCurrentLocale()+commitSetLocaleGen()
    // 提交到 disk/main;若异常冒泡出 broadcastChanged → SET_LOCALE handler 返回 ok:false,
    // 发起 renderer 不更新本地语言(而 disk/main 已是新值)= locale 分裂;且循环中断使该窗口
    // 之后的窗口收不到 CHANGED 广播,同样停在旧语言。每个窗口的 send 独立 try/catch:一个已死
    // 窗口只跳过/记录,不影响其它窗口广播与 SET_LOCALE 返回。镜像下方 menuRebuilder 的
    // try/catch(失败不阻断 locale 同步)。
    try {
      w.webContents.send(I18N_CHANNELS.CHANGED, payload);
    } catch (err) {
      console.error('[i18n] broadcast send failed', err);
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

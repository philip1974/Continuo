// topic 16 i18n: Settings values store ↔ main settings store 桥。
// 沿用 src/theme/binding.ts useThemeBinding 的模式。

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  useSettingValue,
  useSettingsValuesStore,
} from '@/plugins/settings/values-store';
import { useSettingsStore } from '@/stores/settings.store';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
import type { Locale } from '@shared/i18n-types';

const LANGUAGE_SETTING_ID = 'general.language';
const LANGUAGE_DEFAULT: Locale = 'en';

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'zh' || v === 'ko';
}

export function LanguageFromSettings(): ReactNode {
  const value = useSettingValue<Locale>(LANGUAGE_SETTING_ID, LANGUAGE_DEFAULT);
  const rawStored = useSettingsValuesStore(
    (s) => s.values[LANGUAGE_SETTING_ID],
  );
  const setValue = useSettingsValuesStore((s) => s.setValue);
  const storeLocale = useSettingsStore((s) => s.locale);
  const setStoreLocale = useSettingsStore((s) => s.setLocale);
  // race(R1):单调请求 token —— 快速切换语言时多个 setLocale 并发,旧请求稍后失败不得
  // 用过期闭包覆盖后发成功的选择。仅最新请求的失败才反馈/回滚。
  const latestReqRef = useRef(0);

  // values 变化 → call main settings store setLocale（持久化进 settings.json + 广播）。
  // 必须 gate 到「确实有显式 stored value」(rawStored !== undefined):value 在 localStorage
  // 缺失时是 fallback 'en',第一个 effect 无法区分「真存的 en」与「缺省 fallback」。启动时
  // main locale 已是持久化的 zh/ko 而 values 还没该 key → 不 gate 会先把 fallback 'en' 回写
  // main(setLocale 持久化 settings.json + 广播),静默把非默认主语言重置为 en。缺失值只允许
  // 下面的 main → values seed。(codex 复审 loop R14)
  useEffect(() => {
    if (rawStored !== undefined && isLocale(value) && value !== storeLocale) {
      // a11y(A122,A50 同族):setStoreLocale 失败(coApi.i18n.setLocale {ok:false}/reject)会
      // throw,此前 void 丢弃 → 用户改语言后界面仍旧语言但控件显示新值,无反馈。catch 时
      // notify.error + 把控件值回滚到真实 storeLocale(保持一致,value===storeLocale 后 effect
      // 守卫不再重触发)。
      const reqId = ++latestReqRef.current;
      setStoreLocale(value).catch(() => {
        // race(R1):乱序的旧请求失败(已有更新的切换发起)直接忽略,不反馈不回滚 —— 否则
        // 先发失败会反向覆盖后发成功。
        if (reqId !== latestReqRef.current) return;
        notify.error(translate('settings.general.language.save_failed'));
        // 回滚读 live store locale(不用闭包捕获的旧 storeLocale,catch 异步执行时它可能已过期)。
        setValue(LANGUAGE_SETTING_ID, useSettingsStore.getState().locale);
      });
    }
  }, [rawStored, value, storeLocale, setStoreLocale, setValue]);

  // 首次挂载：store locale 已是 main 真值（bootstrap inject），但 values 还没该 key →
  // 把 store.locale 写回 values（让 SegmentedControl 显示正确选中态）
  useEffect(() => {
    if (rawStored === undefined && storeLocale !== LANGUAGE_DEFAULT) {
      setValue(LANGUAGE_SETTING_ID, storeLocale);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

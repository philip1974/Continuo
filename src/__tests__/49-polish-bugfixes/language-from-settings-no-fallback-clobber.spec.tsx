// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 loop R14:LanguageFromSettings 不得把缺省 fallback 当用户选择回写 main。
//
// 根因:useSettingValue('general.language','en') 在 localStorage 缺失时返回 fallback 'en',
// 第一个 effect(values→main setLocale)用它判断,无法区分「真存的 en」与「缺省 fallback」。
// 启动时 main locale 已是持久化的 zh/ko、values 还没该 key → 第一个 effect 先把 fallback 'en'
// 回写 setLocale(持久化 settings.json + 广播)→ 静默把非默认主语言重置为 en + 传到别窗。
//
// 修:第一个 effect gate 到 rawStored !== undefined(确实有显式 stored value)才推 main。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';

const notifyErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../notifications/notify', () => ({
  notify: { error: notifyErrorMock },
}));

import { LanguageFromSettings } from '../../plugins/settings/LanguageFromSettings';
import { useSettingsStore } from '../../stores/settings.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

beforeEach(() => {
  localStorage.clear();
  useSettingsValuesStore.setState({ values: {} });
  notifyErrorMock.mockReset();
});

afterEach(() => cleanup());

describe('topic49 codex-loop R14 · 语言 fallback 不覆盖 main', () => {
  it('main=zh 且 values 缺该 key → 不调 setLocale(en),反而 seed values=zh', async () => {
    const setLocale = vi.fn();
    useSettingsStore.setState({ locale: 'zh', setLocale });
    useSettingsValuesStore.setState({ values: {} }); // rawStored=undefined → value 落 fallback 'en'

    render(<LanguageFromSettings />);

    await waitFor(() => {
      // Effect 2 把 main 的 zh seed 进 values(让 SegmentedControl 正确选中)
      expect(useSettingsValuesStore.getState().values['general.language']).toBe('zh');
    });
    // 关键:绝不能把 fallback 'en' 回写 main
    expect(setLocale).not.toHaveBeenCalledWith('en');
  });

  it('values 有显式 en、main=zh → 保留用户显式选择,setLocale(en) 覆盖 main', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'zh', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'en' } });

    render(<LanguageFromSettings />);

    await waitFor(() => {
      expect(setLocale).toHaveBeenCalledWith('en');
    });
  });

  // a11y(A122,A50 同族):setLocale reject(IPC 失败)→ notify.error + 控件值回滚到真实 storeLocale,
  // 不静默丢弃(此前 void 吞掉,用户改语言无反馈且控件/界面不一致)。
  it('setLocale reject → notify.error + 回滚 values 到真实 locale', async () => {
    const setLocale = vi.fn(() => Promise.reject(new Error('ipc down')));
    useSettingsStore.setState({ locale: 'zh', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'en' } });

    render(<LanguageFromSettings />);

    await waitFor(() => {
      expect(setLocale).toHaveBeenCalledWith('en');
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
    // 控件值回滚到真实 storeLocale(zh),避免显示新值但实际未切
    await waitFor(() => {
      expect(useSettingsValuesStore.getState().values['general.language']).toBe('zh');
    });
  });

  // race(R1):快速切换语言时,先发请求稍后失败不得用过期闭包覆盖后发成功的选择。
  it('R1 快速切换:先发 zh 请求晚失败 → 不反馈不回滚,后发 ko 不被覆盖', async () => {
    const deferreds: Array<{ loc: string; rej: (e: unknown) => void }> = [];
    const setLocale = vi.fn(
      (loc: string) =>
        new Promise<void>((_res, rej) => {
          deferreds.push({ loc, rej });
        }),
    );
    useSettingsStore.setState({ locale: 'en', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'zh' } });

    render(<LanguageFromSettings />);
    await waitFor(() => expect(setLocale).toHaveBeenCalledWith('zh'));

    // 第二次切换 ko(第一次仍 in-flight,store locale 还是 en)
    await act(async () => {
      useSettingsValuesStore.setState({ values: { 'general.language': 'ko' } });
    });
    await waitFor(() => expect(setLocale).toHaveBeenCalledWith('ko'));

    // 先发的 zh 请求稍后失败(stale)→ token 不匹配,catch 应直接忽略
    await act(async () => {
      deferreds.find((d) => d.loc === 'zh')!.rej(new Error('zh failed late'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(notifyErrorMock).not.toHaveBeenCalled();
    expect(useSettingsValuesStore.getState().values['general.language']).toBe('ko');
  });
});

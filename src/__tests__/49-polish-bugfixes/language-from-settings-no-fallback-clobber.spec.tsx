// @vitest-environment jsdom
// topic 49 第十二 session · 复审 loop R14:LanguageFromSettings 不得把缺省 fallback 当用户选择回写 main。
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
  useSettingsStore.setState({ systemLocale: 'en' });
  useSettingsValuesStore.setState({ values: {} });
  notifyErrorMock.mockReset();
});

afterEach(() => cleanup());

describe('topic49 R14 · 语言 fallback 不覆盖 main', () => {
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

// 设置页「恢复默认」(values-store.reset 删掉该 key)→ 控件回到默认 en,真实界面语言也必须回到默认。此前
// 第一个 effect 被 rawStored === undefined 闸门挡住、seed effect 只在挂载时跑 → 控件显示 English、重置按钮消失,
// 界面仍是 zh。
describe('语言项恢复默认', () => {
  it('显式 zh → reset 删 key → setLocale(en)', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'zh', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'zh' } });

    render(<LanguageFromSettings />);
    expect(setLocale).not.toHaveBeenCalled(); // value 与 main 一致,不推

    act(() => {
      useSettingsValuesStore.getState().reset('general.language');
    });
    await waitFor(() => {
      expect(setLocale).toHaveBeenCalledWith('en');
    });
  });

  it('启动时 key 本就缺失(未经 reset)→ 仍不把 fallback en 推给 main', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'ko', setLocale });
    useSettingsValuesStore.setState({ values: {} });
    render(<LanguageFromSettings />);
    await waitFor(() => {
      expect(useSettingsValuesStore.getState().values['general.language']).toBe('ko');
    });
    expect(setLocale).not.toHaveBeenCalledWith('en');
  });
});

describe('语言项恢复默认 — 只响应本窗口的 reset', () => {
  it('别窗 / 外部把 key 删掉(非本窗 reset)→ 不改 main 语言', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'zh', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'zh' } });
    render(<LanguageFromSettings />);
    // 模拟 storage 事件同步进来的「key 消失」(跨窗 lost update / 清站点数据),不经 reset()
    act(() => {
      useSettingsValuesStore.setState({ values: {} });
    });
    await Promise.resolve();
    expect(setLocale).not.toHaveBeenCalledWith('en');
  });

  it('在途切换期间(main 仍是 en)点恢复默认 → 仍推 en,压过在途请求', async () => {
    const setLocale = vi.fn(() => new Promise<void>(() => {})); // 永不落地
    useSettingsStore.setState({ locale: 'en', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'en' } });
    render(<LanguageFromSettings />);
    act(() => {
      useSettingsValuesStore.getState().setValue('general.language', 'zh');
    });
    await waitFor(() => expect(setLocale).toHaveBeenCalledWith('zh'));
    act(() => {
      useSettingsValuesStore.getState().reset('general.language');
    });
    await waitFor(() => expect(setLocale).toHaveBeenLastCalledWith('en'));
  });
});

// 默认值 = 系统语言(main 首启 mapSystemLocale(app.getLocale())):中文 / 韩文系统首启界面已是系统语言,用户
// 从未改过 → 不得写进 values-store(否则设置行显示「已修改」);恢复默认回到系统语言而非写死的 en。
describe('语言项默认 = 系统语言', () => {
  it('中文系统首启(main=zh、values 缺)→ 不 seed values、不调 setLocale', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'zh', systemLocale: 'zh', setLocale });
    render(<LanguageFromSettings />);
    await Promise.resolve();
    expect(useSettingsValuesStore.getState().values['general.language']).toBeUndefined();
    expect(setLocale).not.toHaveBeenCalled();
  });

  it('中文系统、用户改成 en → 推 en;恢复默认 → 推回 zh', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'zh', systemLocale: 'zh', setLocale });
    render(<LanguageFromSettings />);
    act(() => {
      useSettingsValuesStore.getState().setValue('general.language', 'en');
    });
    await waitFor(() => expect(setLocale).toHaveBeenCalledWith('en'));
    act(() => {
      useSettingsValuesStore.getState().reset('general.language');
    });
    await waitFor(() => expect(setLocale).toHaveBeenLastCalledWith('zh'));
  });

  it('中文系统、用户选了 ko 后重启(main=ko、values 缺)→ 仍 seed ko', async () => {
    const setLocale = vi.fn(() => Promise.resolve());
    useSettingsStore.setState({ locale: 'ko', systemLocale: 'zh', setLocale });
    render(<LanguageFromSettings />);
    await waitFor(() => {
      expect(useSettingsValuesStore.getState().values['general.language']).toBe('ko');
    });
    expect(setLocale).not.toHaveBeenCalled();
  });
});

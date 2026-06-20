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
import { render, waitFor, cleanup } from '@testing-library/react';
import { LanguageFromSettings } from '../../plugins/settings/LanguageFromSettings';
import { useSettingsStore } from '../../stores/settings.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

beforeEach(() => {
  localStorage.clear();
  useSettingsValuesStore.setState({ values: {} });
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
    const setLocale = vi.fn();
    useSettingsStore.setState({ locale: 'zh', setLocale });
    useSettingsValuesStore.setState({ values: { 'general.language': 'en' } });

    render(<LanguageFromSettings />);

    await waitFor(() => {
      expect(setLocale).toHaveBeenCalledWith('en');
    });
  });
});

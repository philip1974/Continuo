import { describe, it, expect, beforeEach } from 'vitest';
import {
  useSettingsValuesStore,
  getSettingValue,
} from '../../plugins/settings/values-store';
import type { SettingItemSpec } from '../../plugins/registries/SettingItemRegistry';

const themeSpec: SettingItemSpec = {
  id: 'general.theme',
  category: 'general',
  title: '主题',
  type: 'select',
  default: 'dark',
};

const fontSizeSpec: SettingItemSpec = {
  id: 'editor.fontSize',
  category: 'editor',
  title: '字号',
  type: 'number',
  default: 14,
};

beforeEach(() => {
  globalThis.localStorage.clear();
  useSettingsValuesStore.setState({ values: {} });
});

describe('settings values-store', () => {
  it('初态 values 空,getSettingValue 返 default', () => {
    expect(useSettingsValuesStore.getState().values).toEqual({});
    expect(getSettingValue(themeSpec)).toBe('dark');
    expect(getSettingValue(fontSizeSpec)).toBe(14);
  });

  it('setValue 写入 + getSettingValue 反映', () => {
    useSettingsValuesStore.getState().setValue('general.theme', 'light');
    expect(getSettingValue(themeSpec)).toBe('light');
  });

  it('setValue 持久化到 localStorage', () => {
    useSettingsValuesStore.getState().setValue('editor.fontSize', 18);
    const raw = globalThis.localStorage.getItem('continuo.settings.values');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'editor.fontSize': 18 });
  });

  it('reset 删除 override → 回 default', () => {
    const s = useSettingsValuesStore.getState();
    s.setValue('general.theme', 'light');
    expect(getSettingValue(themeSpec)).toBe('light');
    useSettingsValuesStore.getState().reset('general.theme');
    expect(getSettingValue(themeSpec)).toBe('dark');
  });

  it('reset 不存在的 id → 不变(同 state 引用)', () => {
    const before = useSettingsValuesStore.getState().values;
    useSettingsValuesStore.getState().reset('nope');
    expect(useSettingsValuesStore.getState().values).toBe(before);
  });

  it('resetAll 清所有 override', () => {
    const s = useSettingsValuesStore.getState();
    s.setValue('general.theme', 'light');
    s.setValue('editor.fontSize', 18);
    useSettingsValuesStore.getState().resetAll();
    expect(useSettingsValuesStore.getState().values).toEqual({});
    expect(globalThis.localStorage.getItem('continuo.settings.values')).toBe(
      '{}',
    );
  });
});

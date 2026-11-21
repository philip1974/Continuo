// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SettingItemRow } from '../../plugins/settings/SettingItemRow';
import type {
  SettingItemEnumOption,
  SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';

type Locale = 'en' | 'zh' | 'ko';
type I18nSettingItemSpec = Omit<SettingItemSpec, 'enum'> & {
  readonly titleKey?: string;
  readonly descriptionKey?: string;
  readonly enum?: readonly (SettingItemEnumOption & {
    readonly labelKey?: string;
  })[];
};

let currentLocale: Locale = 'zh';
const mockT = vi.hoisted(() =>
  vi.fn((key: string) => {
    const zh: Record<string, string> = {
      'settings.general.theme.title': '主题',
      'settings.general.theme.description': '应用整体配色',
    };
    const ko: Record<string, string> = {
      'settings.general.theme.title': '테마',
      'settings.general.theme.description': '앱 색상',
    };
    return currentLocale === 'ko' ? (ko[key] ?? key) : (zh[key] ?? key);
  }),
);

vi.mock('@/i18n', () => ({
  useT: () => mockT,
  useLocale: () => currentLocale,
}));

function spec(overrides: Partial<I18nSettingItemSpec>): I18nSettingItemSpec {
  return {
    id: 'general.theme',
    category: 'general',
    title: 'General theme',
    type: 'select',
    default: 'dark',
    enum: [
      { value: 'dark', label: 'Dark', labelKey: 'settings.theme.dark' },
      { value: 'light', label: 'Light', labelKey: 'settings.theme.light' },
    ],
    ...overrides,
  };
}

function renderRow(rowSpec: I18nSettingItemSpec) {
  return render(
    React.createElement(SettingItemRow, {
      spec: rowSpec as SettingItemSpec,
    }),
  );
}

afterEach(() => {
  currentLocale = 'zh';
  mockT.mockClear();
  cleanup();
});

describe('Setting registry titleKey/descriptionKey/labelKey render-time translation — P0-1', () => {
  it('SettingItemSpec.titleKey 设定后 SettingItemRow 渲染调 useT 拿当前 locale 翻译', () => {
    const rowSpec = spec({ titleKey: 'settings.general.theme.title' });

    const { container } = renderRow(rowSpec);

    expect(mockT).toHaveBeenCalledWith('settings.general.theme.title');
    expect(container.textContent).toContain('主题');
  });

  it('切语言后 SettingItemRow 的 title 文本同步更新（rerender）', () => {
    const rowSpec = spec({ titleKey: 'settings.general.theme.title' });
    const view = renderRow(rowSpec);
    expect(view.container.textContent).toContain('主题');

    currentLocale = 'ko';
    view.rerender(
      React.createElement(SettingItemRow, {
        spec: rowSpec as SettingItemSpec,
      }),
    );

    expect(view.container.textContent).toContain('테마');
  });

  it('titleKey 缺失 fallback 到 spec.title 静态值（v0 兼容）', () => {
    const { container } = renderRow(spec({ titleKey: undefined }));

    expect(container.textContent).toContain('General theme');
  });
});

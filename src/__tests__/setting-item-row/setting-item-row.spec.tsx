// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { SettingItemRow } from '../../plugins/settings/SettingItemRow';
import type { SettingItemSpec } from '../../plugins/registries/SettingItemRegistry';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

beforeEach(() => {
  useSettingsValuesStore.setState({ values: {} });
});

afterEach(() => cleanup());

function spec(over: Partial<SettingItemSpec>): SettingItemSpec {
  return {
    id: 'general.test',
    category: 'general',
    title: 'Test',
    type: 'boolean',
    default: false,
    ...over,
  };
}

describe('SettingItemRow — 通用', () => {
  it('渲染 title + id chip + description', () => {
    const { container } = render(
      <SettingItemRow
        spec={spec({
          id: 'general.theme',
          title: '主题',
          description: '应用整体配色',
        })}
      />,
    );
    expect(container.textContent).toContain('主题');
    expect(container.textContent).toContain('general.theme');
    expect(container.textContent).toContain('应用整体配色');
  });

  it('description 缺 → 不渲染描述行', () => {
    const { container } = render(
      <SettingItemRow spec={spec({ id: 'a', title: 'A' })} />,
    );
    expect(container.textContent).not.toMatch(/应用整体配色/);
  });
});

describe('SettingItemRow — boolean', () => {
  it('点 toggle → setValue 翻转,aria-checked 同步', () => {
    const s = spec({ id: 'general.show', type: 'boolean', default: false });
    const { container } = render(<SettingItemRow spec={s} />);
    const toggle = container.querySelector(
      'button[role=switch]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsValuesStore.getState().values['general.show']).toBe(true);
  });
});

describe('SettingItemRow — select', () => {
  it('SegmentedControl 列出 enum,点选项 setValue', () => {
    const s = spec({
      id: 'general.theme',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
    });
    const { container } = render(<SettingItemRow spec={s} />);
    const lightBtn = Array.from(
      container.querySelectorAll<HTMLElement>('button, [role=tab]'),
    ).find((el) => el.textContent === 'Light');
    expect(lightBtn).toBeDefined();
    fireEvent.click(lightBtn!);
    expect(useSettingsValuesStore.getState().values['general.theme']).toBe(
      'light',
    );
  });
});

describe('SettingItemRow — number', () => {
  it('合法数字 → setValue', () => {
    const s = spec({
      id: 'editor.fontSize',
      type: 'number',
      default: 14,
      unit: 'px',
    });
    const { container } = render(<SettingItemRow spec={s} />);
    const input = container.querySelector(
      'input[type=number]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '16' } });
    expect(useSettingsValuesStore.getState().values['editor.fontSize']).toBe(
      16,
    );
    expect(container.textContent).toContain('px');
  });

  it('NaN guard:onChange 给非 finite 字符串不抛(jsdom 会先剥非数字字符)', () => {
    const s = spec({ id: 'editor.fontSize', type: 'number', default: 14 });
    const { container } = render(<SettingItemRow spec={s} />);
    const input = container.querySelector(
      'input[type=number]',
    ) as HTMLInputElement;
    expect(() =>
      fireEvent.change(input, { target: { value: 'abc' } }),
    ).not.toThrow();
  });
});

describe('SettingItemRow — text', () => {
  it('Input value 透传 setValue', () => {
    const s = spec({ id: 'editor.font', type: 'text', default: 'monospace' });
    const { container } = render(<SettingItemRow spec={s} />);
    const input = container.querySelector(
      'input[type=text]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'JetBrains Mono' } });
    expect(useSettingsValuesStore.getState().values['editor.font']).toBe(
      'JetBrains Mono',
    );
  });
});

describe('SettingItemRow — reset', () => {
  it('未 override → reset invisible(布局占位但不响应)', () => {
    const s = spec({ id: 'general.x', type: 'boolean', default: false });
    const { container } = render(<SettingItemRow spec={s} />);
    const resetBtn = container.querySelector(
      'button[aria-label=恢复默认]',
    ) as HTMLButtonElement;
    expect(resetBtn).not.toBeNull();
    expect(resetBtn.className).toContain('invisible');
  });

  it('已 override → 可见 + 点击 reset 删 override', () => {
    const s = spec({ id: 'general.x', type: 'boolean', default: false });
    useSettingsValuesStore.setState({ values: { 'general.x': true } });

    const { container } = render(<SettingItemRow spec={s} />);
    const resetBtn = container.querySelector(
      'button[aria-label=恢复默认]',
    ) as HTMLButtonElement;
    expect(resetBtn.className).not.toContain('invisible');
    fireEvent.click(resetBtn);
    expect(
      useSettingsValuesStore.getState().values['general.x'],
    ).toBeUndefined();
  });
});

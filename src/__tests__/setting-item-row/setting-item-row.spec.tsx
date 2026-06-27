// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import {
  SettingItemRow,
  settingToggleKnobClassName,
  settingToggleSwitchClassName,
} from '../../plugins/settings/SettingItemRow';
import {
  SI_TEXT_VALUE_MAX,
  type SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';
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
  it('reset icon 预创建,不随每个设置项重复创建 svg element', () => {
    const src = readFileSync(join(process.cwd(), 'src/plugins/settings/SettingItemRow.tsx'), 'utf8');

    expect(src).toContain('const RESET_DEFAULT_ICON = (');
    expect(src).toContain('{RESET_DEFAULT_ICON}');
  });

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

  // a11y(A12):未覆盖默认值时 reset 按钮仅 invisible 仍可 Tab 聚焦 → 须 disabled 从 tab
  // 顺序移除。覆盖后(store 有值)按钮启用。
  it('a11y · reset 按钮未覆盖时 disabled、覆盖后启用', () => {
    const { container } = render(
      <SettingItemRow spec={spec({ id: 'general.x', type: 'boolean', default: false })} />,
    );
    const resetBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.getAttribute('aria-label') === '恢复默认')!;
    expect(resetBtn).toBeDefined();
    expect(resetBtn.disabled).toBe(true); // 未覆盖 → 不可聚焦/不可点
    act(() => {
      useSettingsValuesStore.getState().setValue('general.x', true);
    });
    expect(resetBtn.disabled).toBe(false); // 覆盖后启用
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

  // race(R58):setting item 已被插件 unregister(isStillRegistered=false)→ 控件写入被跳过,
  // 不把 override 写到已不存在的 setting id(localStorage 残留 + 同 id 重注册意外继承)。
  it('R58 isStillRegistered=false → 点 toggle 不写 settings value', () => {
    const s = spec({ id: 'gone.flag', type: 'boolean', default: false });
    const { container } = render(
      <SettingItemRow spec={s} isStillRegistered={() => false} />,
    );
    const toggle = container.querySelector(
      'button[role=switch]',
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(useSettingsValuesStore.getState().values['gone.flag']).toBeUndefined();
  });

  it('R58 isStillRegistered=true(默认)→ 正常写入(对照)', () => {
    const s = spec({ id: 'live.flag', type: 'boolean', default: false });
    const { container } = render(
      <SettingItemRow spec={s} isStillRegistered={() => true} />,
    );
    fireEvent.click(
      container.querySelector('button[role=switch]') as HTMLButtonElement,
    );
    expect(useSettingsValuesStore.getState().values['live.flag']).toBe(true);
  });

  // a11y(A4):role=switch 须有可访问名(= 设置标题),否则屏幕阅读器只读「switch checked」
  // 不知切换哪个设置。jsdom 断言 switch 的 aria-label == title。
  it('a11y · boolean switch 有可访问名(= 设置标题)', () => {
    const s = spec({ id: 'general.show', type: 'boolean', title: '显示隐藏文件' });
    const { container } = render(<SettingItemRow spec={s} />);
    const toggle = container.querySelector(
      'button[role=switch]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-label')).toBe('显示隐藏文件');
  });

  it('switch className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(settingToggleSwitchClassName(true)).toContain('bg-accent');
      expect(settingToggleSwitchClassName(false)).toContain(
        'border border-line bg-panel-soft',
      );
      expect(settingToggleKnobClassName(true)).toContain(
        'translate-x-[18px] bg-fg',
      );
      expect(settingToggleKnobClassName(false)).toContain(
        'translate-x-1 bg-fg-muted',
      );
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });
});

// a11y(A21,A4 同族):number/text/select 控件须与设置标题建立可访问关联(aria-labelledby
// 指向标题 id,且该 id 元素文本 == 标题),否则 AT 聚焦只读「spinbutton/edit text/radiogroup」。
function expectLabelledByTitle(
  container: HTMLElement,
  el: HTMLElement | null,
  title: string,
): void {
  expect(el).not.toBeNull();
  const id = el!.getAttribute('aria-labelledby');
  expect(id).toBeTruthy();
  // id 含 '.'(如 setting-title-general.theme)→ 用属性选择器,避免 '#' 把 .x 当 class
  const labelEl = container.querySelector(`[id="${id}"]`);
  expect(labelEl).not.toBeNull();
  expect(labelEl!.textContent).toBe(title);
}

describe('SettingItemRow — a11y label 关联(A21)', () => {
  it('number 输入 aria-labelledby 指向标题', () => {
    const { container } = render(
      <SettingItemRow
        spec={spec({ id: 'editor.fontSize', type: 'number', title: '字号', default: 14 })}
      />,
    );
    expectLabelledByTitle(
      container,
      container.querySelector('input[type=number]'),
      '字号',
    );
  });

  it('text 输入 aria-labelledby 指向标题', () => {
    const { container } = render(
      <SettingItemRow
        spec={spec({ id: 'editor.font', type: 'text', title: '字体', default: 'mono' })}
      />,
    );
    expectLabelledByTitle(
      container,
      container.querySelector('input[type=text]'),
      '字体',
    );
  });

  it('select radiogroup aria-labelledby 指向标题', () => {
    const { container } = render(
      <SettingItemRow
        spec={spec({
          id: 'general.theme',
          type: 'select',
          title: '主题',
          default: 'dark',
          enum: [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ],
        })}
      />,
    );
    expectLabelledByTitle(
      container,
      container.querySelector('[role=radiogroup]'),
      '主题',
    );
  });
});

describe('SettingItemRow — select', () => {
  it('select options 按 locale memoize,不在 JSX 中每次 render 裸 enum.map', () => {
    const src = readFileSync(join(process.cwd(), 'src/plugins/settings/SettingItemRow.tsx'), 'utf8');

    expect(src).toContain('const selectOptions = useMemo');
    expect(src).toContain('[locale, spec.enum, spec.type, t]');
    expect(src).not.toContain('options={spec.enum.map');
  });

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

  // 边界(E293,E290 同族 / before-store 输入截断):text 设置值 Input 加原生 maxLength + onChange slice
  // 到 SI_TEXT_VALUE_MAX(UI-transient 防御,持久层 values-store 另有截断 E142/E241)。
  it('E293 text Input 原生 maxLength = SI_TEXT_VALUE_MAX(neutralize 敏感:原无 maxLength → -1)', () => {
    const s = spec({ id: 'editor.font', type: 'text', default: 'monospace' });
    const { container } = render(<SettingItemRow spec={s} />);
    const input = container.querySelector(
      'input[type=text]',
    ) as HTMLInputElement;
    expect(input.maxLength).toBe(SI_TEXT_VALUE_MAX);
  });

  it('E293 超长 paste → onChange slice + store 截断,最终值长度 ≤ SI_TEXT_VALUE_MAX(回归)', () => {
    const s = spec({ id: 'editor.font', type: 'text', default: 'monospace' });
    const { container } = render(<SettingItemRow spec={s} />);
    const input = container.querySelector(
      'input[type=text]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'x'.repeat(SI_TEXT_VALUE_MAX + 5000) },
    });
    const stored = useSettingsValuesStore.getState().values['editor.font'];
    expect(typeof stored).toBe('string');
    expect((stored as string).length).toBe(SI_TEXT_VALUE_MAX);
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

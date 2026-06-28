// @vitest-environment jsdom
// R16:eventToCombo 现在平台感知。本 spec 在 jsdom(detectPlatform()='other')下,'mod' 主修饰键
// = Ctrl,故 combo 捕获用 ctrlKey 事件 → 编成 'mod+...'(与生产 mac 上 Cmd→'mod' 对称)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import {
  KeybindingCaptureModal,
  eventToCombo,
  selectKeybindingConflicts,
} from '../../plugins/keybindings/KeybindingCaptureModal';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

function defaultProps(over: Partial<Parameters<typeof KeybindingCaptureModal>[0]> = {}) {
  return {
    visible: true,
    commandId: 'cmd.a',
    commandTitle: 'Command A',
    currentHotkey: undefined,
    defaultHotkey: undefined,
    allCommands: [] as readonly CommandSpec[],
    onSave: vi.fn(),
    onClose: vi.fn(),
    onResetToDefault: vi.fn(),
    ...over,
  };
}

function dispatchKey(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: opts.key,
        metaKey: opts.metaKey ?? false,
        ctrlKey: opts.ctrlKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        altKey: opts.altKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function getButtons(): Record<string, HTMLButtonElement> {
  const out: Record<string, HTMLButtonElement> = {};
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    '.wm-modal-content button',
  )) {
    out[b.textContent ?? ''] = b;
  }
  return out;
}

describe('KeybindingCaptureModal — 显示态', () => {
  it('渲染优化 · 快捷键 parts 派生值 memoize,不在 JSX 中重复格式化', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/keybindings/KeybindingCaptureModal.tsx'),
      'utf8',
    );

    expect(src).toContain('const displayHotkeyParts = useMemo(');
    expect(src).toContain('const defaultHotkeyLabel = useMemo(');
    expect(src).toContain('displayHotkeyParts.map');
    expect(src).toContain('hotkey: defaultHotkeyLabel');
    expect(src).not.toContain('formatHotkeyParts(display, PLATFORM).map');
    expect(src).not.toContain('hotkey: formatHotkeyParts(defaultHotkey');
  });

  it('captured=null + currentHotkey=undefined → 显示「按下新组合…」', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '按下新组合…',
    );
  });

  it('visible=false → 不渲染 Modal', () => {
    const props = defaultProps({ visible: false });
    render(<KeybindingCaptureModal {...props} />);
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });

  it('captured 非空 → KeyCap 切片渲染新组合', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    // KeyCap 内部有 mod 标识(⌘ on mac, Ctrl on others);至少 'X' 字符在
    const modal = document.querySelector('.wm-modal-content')!;
    expect(modal.textContent).toMatch(/X/i);
  });

  // a11y(A52,A41 同族):捕获后动态出现的冲突警告须 live region(role=status/polite),否则焦点
  // 在弹窗内的屏幕阅读器用户听不到冲突,可能保存已冲突的快捷键。
  it('a11y · 捕获到冲突组合 → 警告在 role=status live region', () => {
    const props = defaultProps({
      commandId: 'cmd.a',
      allCommands: [
        { id: 'cmd.b', title: 'Other Command', hotkey: 'mod+x', fn: vi.fn() },
      ] as readonly CommandSpec[],
    });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true }); // → 'mod+x' 与 cmd.b 冲突
    // A61 起捕获结果框本身也是 role=status → 同页两个 live region,用 .some() 按文本定位冲突警告。
    const statuses = Array.from(
      document.querySelectorAll('.wm-modal-content [role=status]'),
    );
    const conflict = statuses.find((s) => s.textContent?.includes('Other Command'));
    expect(conflict).toBeTruthy();
    // a11y(A89):conflict_title catalog 已去 ⚠️;视觉 emoji 在 aria-hidden span 内。
    const warnEmoji = conflict!.querySelector('span[aria-hidden="true"]');
    expect(warnEmoji).not.toBeNull();
    expect(warnEmoji!.textContent).toContain('⚠️');
  });

  // a11y(A61,A52 同族):捕获结果框本身须 live region —— 按键由 document capture 处理,焦点不在
  // 框上,内容随按键动态切换;无 live region 时 AT 用户听不到捕获结果。
  it('a11y · 捕获结果框是 role=status,内容随按键更新', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    // 占位态:框含「按下新组合…」且在 role=status 内
    const statuses0 = Array.from(
      document.querySelectorAll('.wm-modal-content [role=status]'),
    );
    const box0 = statuses0.find((s) => s.textContent?.includes('按下新组合'));
    expect(box0).toBeTruthy();
    // 按下组合 → 同一 role=status 框反映新组合(X)
    dispatchKey({ key: 'x', ctrlKey: true });
    const statuses1 = Array.from(
      document.querySelectorAll('.wm-modal-content [role=status]'),
    );
    const box1 = statuses1.find((s) => /X/i.test(s.textContent ?? ''));
    expect(box1).toBeTruthy();
    // Backspace → 未绑定,仍在 role=status 内
    dispatchKey({ key: 'Backspace' });
    const statuses2 = Array.from(
      document.querySelectorAll('.wm-modal-content [role=status]'),
    );
    const box2 = statuses2.find((s) => s.textContent?.includes('未绑定'));
    expect(box2).toBeTruthy();
  });
});

describe('KeybindingCaptureModal — 按键', () => {
  // a11y(A62):Tab 不能被当组合捕获,否则键盘用户无法在弹窗按钮间移动焦点(键盘陷阱)。
  it('a11y · 按 Tab 不捕获组合、不阻止默认(放行焦点导航)', () => {
    const onSave = vi.fn();
    const props = defaultProps({ onSave });
    render(<KeybindingCaptureModal {...props} />);

    const ev = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(ev);
    });

    // Tab 未被 preventDefault → 默认 Tab 焦点导航可进行
    expect(ev.defaultPrevented).toBe(false);
    // 未捕获任何组合 → 保存仍 disabled、占位文案仍在
    expect(getButtons()['保存'].disabled).toBe(true);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '按下新组合…',
    );
  });

  // Shift+Tab 同理(key 仍是 'Tab')须放行反向焦点导航。
  it('a11y · 按 Shift+Tab 同样放行(不捕获、不阻止默认)', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    const ev = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(getButtons()['保存'].disabled).toBe(true);
  });

  // a11y(A63,A62 同族):焦点在按钮上时 Enter/Space 须放行激活,不能被当组合捕获。
  it('a11y · 焦点在按钮上按 Enter 不捕获组合、不阻止默认(放行激活)', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    // 先捕获一个组合,使 captured 非空(便于检测 Enter 是否会改写它)
    dispatchKey({ key: 'x', ctrlKey: true });
    const before = document.querySelector('.wm-modal-content')!.textContent;
    const saveBtn = getButtons()['保存'];
    // 在按钮上派发 Enter(document capture handler 会收到,e.target=按钮)
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      saveBtn.dispatchEvent(ev);
    });
    // 未被 preventDefault(放行按钮激活)且 captured 未被改写成 'enter'
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector('.wm-modal-content')!.textContent).toBe(before);
  });

  it('a11y · 焦点在按钮上按 Space 同样放行(不捕获、不阻止默认)', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    const before = document.querySelector('.wm-modal-content')!.textContent;
    const saveBtn = getButtons()['保存'];
    const ev = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      saveBtn.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(document.querySelector('.wm-modal-content')!.textContent).toBe(before);
  });

  // 带修饰键的 Enter(mod+enter)按钮不会激活,仍按组合捕获(不破坏绑定能力)。
  it('a11y · mod+Enter 仍捕获为组合(不放行)', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    const saveBtn = getButtons()['保存'];
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      saveBtn.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    // 捕获成 'mod+enter' → 保存可用
    expect(getButtons()['保存'].disabled).toBe(false);
  });

  it('单独修饰键不更新 captured(保存按钮仍 disabled)', () => {
    const onSave = vi.fn();
    const props = defaultProps({ onSave });
    render(<KeybindingCaptureModal {...props} />);

    dispatchKey({ key: 'Meta', ctrlKey: true });
    dispatchKey({ key: 'Shift', shiftKey: true });
    expect(getButtons()['保存']!.disabled).toBe(true);
  });

  it('Backspace → captured="",显示「未绑定」', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'Backspace' });
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '未绑定',
    );
  });
});

describe('KeybindingCaptureModal — 保存 / 重置', () => {
  it('captured=null → 保存 disabled', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    expect(getButtons()['保存']!.disabled).toBe(true);
  });

  it('captured=组合 → 保存调 onSave + onClose', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const props = defaultProps({ onSave, onClose });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'k', ctrlKey: true });

    fireEvent.click(getButtons()['保存']!);
    expect(onSave).toHaveBeenCalledWith('mod+k');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('captured="" → 保存空字符串(unbind 路径)', () => {
    const onSave = vi.fn();
    const props = defaultProps({ onSave });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'Backspace' });
    fireEvent.click(getButtons()['保存']!);
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('defaultHotkey 缺 + captured 未设 → 重置默认 disabled', () => {
    const props = defaultProps({ defaultHotkey: undefined });
    render(<KeybindingCaptureModal {...props} />);
    expect(getButtons()['重置默认']!.disabled).toBe(true);
  });

  it('defaultHotkey 存在 → 重置默认启用,点击调 onResetToDefault + onClose', () => {
    const onResetToDefault = vi.fn();
    const onClose = vi.fn();
    const props = defaultProps({
      defaultHotkey: 'mod+s',
      onResetToDefault,
      onClose,
    });
    render(<KeybindingCaptureModal {...props} />);
    fireEvent.click(getButtons()['重置默认']!);
    expect(onResetToDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('KeybindingCaptureModal — 冲突检测', () => {
  it('selectKeybindingConflicts 用一次循环收集冲突,不通过 filter 物化', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.a', title: 'A', hotkey: 'mod+old', fn: () => {} },
      { id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} },
      { id: 'cmd.c', title: 'C', hotkey: 'mod+x', fn: () => {} },
    ];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');
    const iteratorSpy = vi.spyOn(all, Symbol.iterator);

    try {
      const conflicts = selectKeybindingConflicts(all, 'cmd.a', 'mod+x');
      const filterCallsDuringSelect = filterSpy.mock.calls.length;
      expect(conflicts.map((c) => c.id)).toEqual(['cmd.b', 'cmd.c']);
      expect(filterCallsDuringSelect).toBe(0);
      expect(iteratorSpy).toHaveBeenCalledTimes(1);
      expect(selectKeybindingConflicts.toString()).not.toContain(
        'conflicts.push(',
      );
    } finally {
      filterSpy.mockRestore();
      iteratorSpy.mockRestore();
    }
  });

  it('其它命令的 effective hotkey 与 captured 相同 → 显示警告', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.a', title: 'A', hotkey: 'mod+old', fn: () => {} },
      { id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} },
    ];
    const props = defaultProps({ allCommands: all });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '此组合已绑定到其它命令',
    );
  });

  it('captured=null → 不显示警告', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} },
    ];
    const props = defaultProps({ allCommands: all });
    render(<KeybindingCaptureModal {...props} />);
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).not.toContain('此组合已绑定');
  });
});

describe('KeybindingCaptureModal — visible 切换 → captured 复位', () => {
  it('false → true 时新一轮捕获从 null 开始', () => {
    const props = defaultProps({ visible: true });
    const { rerender } = render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'k', ctrlKey: true });
    rerender(<KeybindingCaptureModal {...props} visible={false} />);
    rerender(<KeybindingCaptureModal {...props} visible={true} />);

    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '按下新组合…',
    );
  });
});

describe('KeybindingCaptureModal — 取消', () => {
  it('点取消 → onClose', () => {
    const onClose = vi.fn();
    const props = defaultProps({ onClose });
    render(<KeybindingCaptureModal {...props} />);
    fireEvent.click(getButtons()['取消']!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// 边界(E145):eventToCombo 只产出注册侧 HOTKEY_SHAPE_RE 接受的合法形态;无法表示的组合(Space
// 含空白、主键 '+' → 空段)返 null,不捕获(否则持久化的绑定永不触发 + 显示异常)。jsdom 平台
// 'other':ctrlKey → 'mod' 主修饰键。
describe('eventToCombo — E145 拒非法 hotkey 形态', () => {
  const ev = (o: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }): KeyboardEvent =>
    ({
      ctrlKey: o.ctrlKey ?? false,
      metaKey: o.metaKey ?? false,
      shiftKey: o.shiftKey ?? false,
      altKey: o.altKey ?? false,
      key: o.key,
    }) as KeyboardEvent;

  it('Space(key=" ")→ null(含空白不可表示)', () => {
    expect(eventToCombo(ev({ key: ' ', ctrlKey: true }))).toBeNull();
  });

  it('主键为 "+"(→ shift++ 空段)→ null', () => {
    expect(eventToCombo(ev({ key: '+', shiftKey: true }))).toBeNull();
  });

  it('合法 ctrl+x → "mod+x"(jsdom other:ctrl→mod)', () => {
    expect(eventToCombo(ev({ key: 'x', ctrlKey: true }))).toBe('mod+x');
  });

  it('小写主键不调用 toLowerCase', () => {
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      expect(eventToCombo(ev({ key: 'x', ctrlKey: true }))).toBe('mod+x');
      expect(lowerSpy.mock.contexts.some((ctx) => String(ctx) === 'x')).toBe(
        false,
      );
      expect(eventToCombo(ev({ key: 'X', ctrlKey: true }))).toBe('mod+x');
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('组合片段直接拼接,不分配 parts 数组/不通过 push 扩容', () => {
    expect(eventToCombo(ev({ key: 'x', ctrlKey: true, shiftKey: true }))).toBe(
      'mod+shift+x',
    );
    expect(eventToCombo.toString()).not.toContain('new Array<string>(5)');
    expect(eventToCombo.toString()).not.toContain('parts.push(');
  });

  it('纯修饰键 → null(不算完整组合)', () => {
    expect(eventToCombo(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
  });
});

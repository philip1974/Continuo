// @vitest-environment jsdom
// R16:eventToCombo 现在平台感知。本 spec 在 jsdom(detectPlatform()='other')下,'mod' 主修饰键
// = Ctrl,故 combo 捕获用 ctrlKey 事件 → 编成 'mod+...'(与生产 mac 上 Cmd→'mod' 对称)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';

vi.mock('../../plugins/keybindings/keybindings-store', async (importActual) => {
  const actual = await importActual<typeof import('../../plugins/keybindings/keybindings-store')>();
  return { ...actual, getEffectiveHotkey: vi.fn(actual.getEffectiveHotkey) };
});

import {
  KeybindingCaptureModal,
  eventToCombo,
  selectKeybindingConflicts,
  selectReservedPickerHotkey,
} from '../../plugins/keybindings/KeybindingCaptureModal';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../../plugins/keybindings/keybindings-store';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';
import { getLocale, notifyLocaleChange, setLocale } from '../../i18n';

const getEffSpy = getEffectiveHotkey as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
  getEffSpy.mockClear();
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
    overrides: {},
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
  for (const b of document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')) {
    out[b.textContent ?? ''] = b;
  }
  return out;
}

function getButton(label: string): HTMLButtonElement {
  const button = getButtons()[label];
  expect(button).toBeDefined();
  return button!;
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

  it('visible=false shell 直接返回,不订阅 i18n 或初始化捕获状态', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/keybindings/KeybindingCaptureModal.tsx'),
      'utf8',
    );
    const shellStart = src.indexOf('export function KeybindingCaptureModal(');
    const bodyStart = src.indexOf('function KeybindingCaptureModalBody');
    const shellSrc = src.slice(shellStart, bodyStart);

    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(bodyStart).toBeGreaterThan(shellStart);
    expect(shellSrc).toContain('if (!visible) return null;');
    expect(shellSrc).not.toContain('useT(');
    expect(shellSrc).not.toContain('useState(');
    expect(src.indexOf('const t = useT();')).toBeGreaterThan(bodyStart);
  });

  it('captured=null + currentHotkey=undefined → 显示「按下新组合…」', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('按下新组合…');
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
    const statuses = Array.from(document.querySelectorAll('.wm-modal-content [role=status]'));
    const conflict = statuses.find((s) => s.textContent?.includes('Other Command'));
    expect(conflict).toBeTruthy();
    // a11y(A89):conflict_title catalog 已去 ⚠️;视觉 emoji 在 aria-hidden span 内。
    const warnEmoji = conflict!.querySelector('span[aria-hidden="true"]');
    expect(warnEmoji).not.toBeNull();
    expect(warnEmoji!.textContent).toContain('⚠️');
  });

  it('冲突列表显示本地化的命令标题(titleKey),不是原始英文 title', () => {
    const props = defaultProps({
      commandId: 'cmd.a',
      allCommands: [
        {
          id: 'terminal.new',
          title: 'New Terminal',
          titleKey: 'commands.terminal.new.title',
          hotkey: 'mod+x',
          fn: vi.fn(),
        },
      ] as readonly CommandSpec[],
    });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    const text = document.querySelector('.wm-modal-content')!.textContent ?? '';
    expect(text).toContain('新建终端');
    expect(text).not.toContain('New Terminal');
  });

  // a11y(A61,A52 同族):捕获结果框本身须 live region —— 按键由 document capture 处理,焦点不在
  // 框上,内容随按键动态切换;无 live region 时 AT 用户听不到捕获结果。
  it('a11y · 捕获结果框是 role=status,内容随按键更新', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    // 占位态:框含「按下新组合…」且在 role=status 内
    const statuses0 = Array.from(document.querySelectorAll('.wm-modal-content [role=status]'));
    const box0 = statuses0.find((s) => s.textContent?.includes('按下新组合'));
    expect(box0).toBeTruthy();
    // 按下组合 → 同一 role=status 框反映新组合(X)
    dispatchKey({ key: 'x', ctrlKey: true });
    const statuses1 = Array.from(document.querySelectorAll('.wm-modal-content [role=status]'));
    const box1 = statuses1.find((s) => /X/i.test(s.textContent ?? ''));
    expect(box1).toBeTruthy();
    // Backspace → 未绑定,仍在 role=status 内
    dispatchKey({ key: 'Backspace' });
    const statuses2 = Array.from(document.querySelectorAll('.wm-modal-content [role=status]'));
    const box2 = statuses2.find((s) => s.textContent?.includes('未绑定'));
    expect(box2).toBeTruthy();
  });
});

// 标签与命令名、提示文案与键帽之间要有空格(读屏同样连读):此前渲染成「Command:Command A」「then[Enter]」
// 「to cancel;default」。zh 沿用目录里的标点,只补空格。
describe('KeybindingCaptureModal — 文案间距', () => {
  const original = getLocale();
  afterEach(() => {
    act(() => {
      setLocale(original);
      notifyLocaleChange();
    });
  });

  const CASES = [
    ['en', 'Command: Command A', 'Press a new combination, then Enter to save; Backspace to clear; Esc to cancel; default '],
    ['ko', '명령: Command A', '새 조합을 누른 뒤 Enter 저장; Backspace 지우기; Esc 취소; 기본 '],
    ['zh', '命令: Command A', '按下新组合后, Enter 保存; Backspace 清空; Esc 取消; 默认 '],
  ] as const;

  it.each(CASES)('%s:标签与命令名、提示与键帽之间有空格', (locale, commandLine, hint) => {
    act(() => {
      setLocale(locale);
      notifyLocaleChange();
    });
    render(<KeybindingCaptureModal {...defaultProps({ defaultHotkey: 'mod+k' })} />);
    const title = document.getElementById('keybinding-capture-title')!;
    expect(title.nextElementSibling!.textContent).toBe(commandLine);
    const hints = document.querySelector('[data-testid="keybinding-capture-hints"]')!;
    expect(hints.textContent).toContain(hint);
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
    expect(getButton('保存').disabled).toBe(true);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('按下新组合…');
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
    expect(getButton('保存').disabled).toBe(true);
  });

  // a11y(A63,A62 同族):焦点在按钮上时 Enter/Space 须放行激活,不能被当组合捕获。
  it('a11y · 焦点在按钮上按 Enter 不捕获组合、不阻止默认(放行激活)', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    // 先捕获一个组合,使 captured 非空(便于检测 Enter 是否会改写它)
    dispatchKey({ key: 'x', ctrlKey: true });
    const before = document.querySelector('.wm-modal-content')!.textContent;
    const saveBtn = getButton('保存');
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
    const saveBtn = getButton('保存');
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
    const saveBtn = getButton('保存');
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
    expect(getButton('保存').disabled).toBe(false);
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
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('未绑定');
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
      expect(selectKeybindingConflicts.toString()).not.toContain('conflicts.push(');
    } finally {
      filterSpy.mockRestore();
      iteratorSpy.mockRestore();
    }
  });

  it('冲突检测使用传入 overrides 快照,不逐条 getEffectiveHotkey 读 store', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.a', title: 'A', hotkey: 'mod+old', fn: () => {} },
      { id: 'cmd.b', title: 'B', hotkey: 'mod+b', fn: () => {} },
      { id: 'cmd.c', title: 'C', hotkey: 'mod+x', fn: () => {} },
    ];
    useKeybindingsStore.setState({ overrides: {} });

    const conflicts = selectKeybindingConflicts(all, 'cmd.a', 'mod+x', {
      'cmd.b': 'mod+x',
    });

    expect(conflicts.map((c) => c.id)).toEqual(['cmd.b', 'cmd.c']);
    expect(getEffSpy).not.toHaveBeenCalled();
  });

  it('修饰键顺序 / 别名不同但运行时同一组合 → 判为冲突', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.a', title: 'A', hotkey: 'mod+old', fn: () => {} },
      { id: 'cmd.b', title: 'B', hotkey: 'shift+mod+enter', fn: () => {} },
      { id: 'cmd.c', title: 'C', hotkey: 'option+y', fn: () => {} },
      { id: 'cmd.d', title: 'D', hotkey: 'shift+alt+z', fn: () => {} },
    ];
    expect(
      selectKeybindingConflicts(all, 'cmd.a', 'mod+shift+enter').map((c) => c.id),
    ).toEqual(['cmd.b']);
    expect(selectKeybindingConflicts(all, 'cmd.a', 'alt+y').map((c) => c.id)).toEqual([
      'cmd.c',
    ]);
    expect(selectKeybindingConflicts(all, 'cmd.a', 'alt+shift+z').map((c) => c.id)).toEqual([
      'cmd.d',
    ]);
    // 不同组合不误报
    expect(selectKeybindingConflicts(all, 'cmd.a', 'mod+enter')).toEqual([]);
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
    const all: CommandSpec[] = [{ id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} }];
    const props = defaultProps({ allCommands: all });
    render(<KeybindingCaptureModal {...props} />);
    expect(document.querySelector('.wm-modal-content')!.textContent).not.toContain('此组合已绑定');
  });
});

describe('KeybindingCaptureModal — Quick Open / 命令面板保留键', () => {
  it('selectReservedPickerHotkey 平台感知:mod+p / mod+shift+p 为保留键,其它不是', () => {
    expect(selectReservedPickerHotkey('mod+p', 'other')).toBe('quick_open');
    expect(selectReservedPickerHotkey('shift+mod+p', 'other')).toBe('command_palette');
    expect(selectReservedPickerHotkey('ctrl+p', 'other')).toBe('quick_open');
    expect(selectReservedPickerHotkey('mod+p', 'mac')).toBe('quick_open');
    expect(selectReservedPickerHotkey('mod+shift+p', 'mac')).toBe('command_palette');
    // mac 上 picker 只认 Cmd:Ctrl+P 不被拦,可绑定
    expect(selectReservedPickerHotkey('ctrl+p', 'mac')).toBeNull();
    expect(selectReservedPickerHotkey('mod+alt+p', 'other')).toBeNull();
    expect(selectReservedPickerHotkey('mod+o', 'other')).toBeNull();
    expect(selectReservedPickerHotkey('', 'other')).toBeNull();
    expect(selectReservedPickerHotkey(null, 'other')).toBeNull();
  });

  it('录到 Quick Open 的 ⌘P(jsdom other = Ctrl+P)→ 提示冲突且保存 disabled', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'p', ctrlKey: true });
    const alert = document.querySelector('.wm-modal-content [role="alert"]');
    expect(alert?.textContent).toContain('快速打开');
    expect(getButton('保存').disabled).toBe(true);
  });

  it('录到命令面板的 ⌘⇧P → 提示冲突且保存 disabled;改按其它组合恢复可保存', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'P', ctrlKey: true, shiftKey: true });
    expect(document.querySelector('.wm-modal-content [role="alert"]')?.textContent).toContain(
      '命令面板',
    );
    expect(getButton('保存').disabled).toBe(true);
    dispatchKey({ key: 'k', ctrlKey: true });
    expect(document.querySelector('.wm-modal-content [role="alert"]')).toBeNull();
    expect(getButton('保存').disabled).toBe(false);
  });
});

// VSCode 录键框(DefineKeybindingWidget):焦点在录制输入框,Enter = 接受已录组合,Esc = 取消;
// 无修饰的 Enter 不可录成按键(带修饰的 Shift/Ctrl+Enter 照常可录)。
describe('KeybindingCaptureModal — 录制区焦点 + Enter 保存(VSCode 录键框)', () => {
  function captureArea(): HTMLElement {
    const el = document.querySelector<HTMLElement>('[data-testid="keybinding-capture-area"]');
    expect(el).not.toBeNull();
    return el!;
  }

  function pressEnterOn(target: EventTarget): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  }

  it('打开后初始焦点落在录制区(不在「取消」按钮上)', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    try {
      render(<KeybindingCaptureModal {...defaultProps()} />);
      expect(captureArea().tabIndex).toBe(0);
      expect(document.activeElement).toBe(captureArea());
    } finally {
      raf.mockRestore();
    }
  });

  it('录到组合后在录制区按 Enter → onSave(组合) + onClose,Enter 不被录成按键', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<KeybindingCaptureModal {...defaultProps({ onSave, onClose })} />);
    dispatchKey({ key: 'k', ctrlKey: true });
    const ev = pressEnterOn(captureArea());
    expect(ev.defaultPrevented).toBe(true);
    expect(onSave).toHaveBeenCalledWith('mod+k');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Backspace 清空后按 Enter → 保存空(解绑)', () => {
    const onSave = vi.fn();
    render(<KeybindingCaptureModal {...defaultProps({ onSave, currentHotkey: 'mod+s' })} />);
    dispatchKey({ key: 'Backspace' });
    pressEnterOn(captureArea());
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('尚未录到组合时按 Enter → 不保存、不关闭,也不把 Enter 录成按键', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<KeybindingCaptureModal {...defaultProps({ onSave, onClose })} />);
    pressEnterOn(captureArea());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getButton('保存').disabled).toBe(true);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('按下新组合…');
  });

  it('录到保留键时按 Enter → 不保存', () => {
    const onSave = vi.fn();
    render(<KeybindingCaptureModal {...defaultProps({ onSave })} />);
    dispatchKey({ key: 'p', ctrlKey: true });
    pressEnterOn(captureArea());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('录到与其它命令冲突的组合时按 Enter → 不保存(须显式点「保存」确认)', () => {
    const onSave = vi.fn();
    const all: CommandSpec[] = [{ id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} }];
    render(<KeybindingCaptureModal {...defaultProps({ onSave, allCommands: all })} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    pressEnterOn(captureArea());
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(getButton('保存'));
    expect(onSave).toHaveBeenCalledWith('mod+x');
  });

  it('Shift+Enter 仍可录成组合', () => {
    render(<KeybindingCaptureModal {...defaultProps()} />);
    dispatchKey({ key: 'Enter', shiftKey: true });
    expect(getButton('保存').disabled).toBe(false);
  });
});

describe('KeybindingCaptureModal — visible 切换 → captured 复位', () => {
  it('false → true 时新一轮捕获从 null 开始', () => {
    const props = defaultProps({ visible: true });
    const { rerender } = render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'k', ctrlKey: true });
    rerender(<KeybindingCaptureModal {...props} visible={false} />);
    rerender(<KeybindingCaptureModal {...props} visible={true} />);

    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('按下新组合…');
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
      expect(lowerSpy.mock.contexts.some((ctx) => String(ctx) === 'x')).toBe(false);
      expect(eventToCombo(ev({ key: 'X', ctrlKey: true }))).toBe('mod+x');
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('组合片段直接拼接,不分配 parts 数组/不通过 push 扩容', () => {
    expect(eventToCombo(ev({ key: 'x', ctrlKey: true, shiftKey: true }))).toBe('mod+shift+x');
    expect(eventToCombo.toString()).not.toContain('new Array<string>(5)');
    expect(eventToCombo.toString()).not.toContain('parts.push(');
  });

  it('纯修饰键 → null(不算完整组合)', () => {
    expect(eventToCombo(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
  });
});

describe('onClose 引用不稳定时焦点不被重置', () => {
  it('父组件以新的内联 onClose 重渲染 → 弹窗内焦点保持;Escape 调用最新的 onClose', async () => {
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const first = vi.fn();
    const { rerender, getAllByRole } = render(
      <KeybindingCaptureModal
        {...defaultProps({ onClose: first, currentHotkey: 'mod+j', defaultHotkey: 'mod+k' })}
      />,
    );
    await frame(); // Modal 打开时的初始聚焦在 rAF 里
    const enabled = (getAllByRole('button') as HTMLButtonElement[]).filter((b) => !b.disabled);
    // 选一个不是 Modal 初始聚焦目标的按钮,否则「焦点被拉回」与「焦点未动」无法区分。
    const initial = document.activeElement;
    const target = enabled.find((b) => b !== initial)!;
    expect(target).toBeDefined();
    act(() => target.focus());
    expect(document.activeElement).toBe(target);

    const latest = vi.fn();
    rerender(
      <KeybindingCaptureModal
        {...defaultProps({ onClose: latest, currentHotkey: 'mod+j', defaultHotkey: 'mod+k' })}
      />,
    );
    await frame(); // Modal 的焦点 effect 若重跑,会在下一帧把焦点拉回首个可聚焦元素
    expect(document.activeElement).toBe(target);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(latest).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });
});

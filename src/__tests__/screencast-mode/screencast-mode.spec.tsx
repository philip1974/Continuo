// @vitest-environment jsdom
// BDD: screencast-mode —— 开发者: 切换屏幕录制模式(命令、键位 + 命令名、敏感输入不显示、累积 / 淡出、浮层与鼠标圆圈)。见同目录 README。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@/i18n';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { coApp } from '@/plugins/co-app';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import {
  recordScreencastPress,
  screencastCommandSpec,
  toggleScreencastMode,
  useScreencastStore,
} from '@/shell/screencast/screencast-store';
import { describeScreencastKey, isSensitiveKeyTarget } from '@/shell/screencast/screencast-keys';
import ScreencastOverlay from '@/shell/screencast/ScreencastOverlay';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const QUICK_OPEN: CommandSpec = {
  id: 'workbench.action.quickOpen',
  title: 'Go to File…',
  titleKey: 'commands.quick_open.title',
  fn: () => undefined,
};
const TOGGLE_SIDEBAR: CommandSpec = {
  id: 'explorer.toggleSidebar',
  title: 'Toggle Sidebar',
  hotkey: 'mod+b',
  fn: () => undefined,
};
const commands = {
  all: [QUICK_OPEN, TOGGLE_SIDEBAR],
  get: (id: string) => [QUICK_OPEN, TOGGLE_SIDEBAR].find((c) => c.id === id),
};
const key = (init: KeyboardEventInit, target?: Element): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(e, 'target', { value: target });
  return e;
};
const describeMac = (e: KeyboardEvent) => describeScreencastKey(e, commands, 'mac', {});
const texts = () => useScreencastStore.getState().presses.map((p) => (p.title ? `${p.title} ${p.keys}` : p.keys));

beforeEach(() => {
  setLocale('en');
  useScreencastStore.setState({ enabled: false, presses: [], visible: false, doc: null, mouse: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('命令', () => {
  it('workbench.action.toggleScreencastMode:分类「开发者」,三语标题,无默认键(VSCode 同)', () => {
    const spec = screencastCommandSpec();
    expect(spec).toMatchObject({ id: 'workbench.action.toggleScreencastMode', categoryKey: 'commands.developer.category' });
    expect(spec.hotkey).toBeUndefined();
    expect(en[spec.titleKey as keyof typeof en]).toBe('Toggle Screencast Mode');
    expect(zh[spec.titleKey as keyof typeof zh]).toBe('切换屏幕录制模式');
    expect(zh['commands.developer.category']).toBe('开发者');
    expect(ko[spec.titleKey as keyof typeof ko]).toEqual(expect.any(String));
    const plugin = readFileSync(join(process.cwd(), 'src/core-plugins/WindowPlugin.ts'), 'utf8');
    expect(plugin).toContain('this.addCommand(screencastCommandSpec())');
    expect(readFileSync(join(process.cwd(), 'src/shell/App.tsx'), 'utf8')).toContain('<ScreencastHost />');
  });

  it('再次执行关闭,并清空浮层条目;开关只在内存里', () => {
    toggleScreencastMode();
    expect(useScreencastStore.getState().enabled).toBe(true);
    recordScreencastPress({ keys: 'A' }, false, document, 800);
    toggleScreencastMode();
    expect(useScreencastStore.getState()).toMatchObject({ enabled: false, presses: [], visible: false });
    expect(localStorage.length).toBe(0);
  });
});

describe('键位 + 命令名', () => {
  it('⌘P(picker 保留键)→「Go to File… ⌘P」,先清空', () => {
    expect(describeMac(key({ key: 'p', code: 'KeyP', metaKey: true }))).toEqual({
      press: { keys: '⌘P', title: 'Go to File…' },
      restart: true,
    });
  });

  it('绑定的命令 → 标题 + 键位;界面语言切换后用该语言标题', () => {
    expect(describeMac(key({ key: 'b', code: 'KeyB', metaKey: true }))?.press).toEqual({ keys: '⌘B', title: 'Toggle Sidebar' });
    setLocale('zh');
    expect(describeMac(key({ key: 'p', code: 'KeyP', metaKey: true }))?.press.title).toBe('转到文件…');
  });

  it('普通字符键只显示键位、不清空;Windows / Linux 用 Ctrl+ 格式', () => {
    expect(describeMac(key({ key: 'a', code: 'KeyA' }))).toEqual({ press: { keys: 'A' }, restart: false });
    expect(describeScreencastKey(key({ key: 'p', code: 'KeyP', ctrlKey: true }), commands, 'other', {})?.press.keys).toBe('Ctrl+P');
  });

  it('单独修饰键、输入法组字中的按键不显示', () => {
    expect(describeMac(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
    expect(describeMac(key({ key: 'a', code: 'KeyA', isComposing: true }))).toBeNull();
  });

  it('Backspace / Esc / 方向键先清空', () => {
    for (const k of ['Backspace', 'Escape', 'ArrowLeft']) expect(describeMac(key({ key: k }))?.restart, k).toBe(true);
  });
});

describe('敏感输入不显示', () => {
  it.each([
    ['type=password', '<input type="password">'],
    ['autocomplete=one-time-code', '<input autocomplete="one-time-code">'],
    ['autocomplete 含 current-password', '<input autocomplete="username current-password">'],
    ['data-screencast-sensitive 区域内', '<div data-screencast-sensitive=""><input></div>'],
  ])('%s', (_label, html) => {
    document.body.innerHTML = html;
    const input = document.querySelector('input')!;
    expect(isSensitiveKeyTarget(input)).toBe(true);
    expect(describeMac(key({ key: 'a', code: 'KeyA' }, input))).toBeNull();
  });

  it('普通输入框照常显示;插件「从 Git URL 安装」的地址框带敏感标记', () => {
    document.body.innerHTML = '<input type="text">';
    expect(isSensitiveKeyTarget(document.querySelector('input'))).toBe(false);
    expect(readFileSync(join(process.cwd(), 'src/plugins/GitUrlInstallForm.tsx'), 'utf8')).toContain('data-screencast-sensitive');
  });
});

describe('累积与淡出', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toggleScreencastMode();
  });

  it('普通字符累积;带修饰键的组合先清空;超时后淡出,之后的按键从空开始', () => {
    recordScreencastPress({ keys: 'A' }, false, document, 800);
    recordScreencastPress({ keys: 'B' }, false, document, 800);
    expect(texts()).toEqual(['A', 'B']);
    recordScreencastPress({ keys: '⌘P', title: 'Go to File…' }, true, document, 800);
    expect(texts()).toEqual(['Go to File… ⌘P']);
    vi.advanceTimersByTime(799);
    expect(useScreencastStore.getState().visible).toBe(true);
    vi.advanceTimersByTime(1);
    // 淡出期间条目保留(动画里仍看得到)
    expect(useScreencastStore.getState()).toMatchObject({ visible: false });
    expect(texts()).toEqual(['Go to File… ⌘P']);
    recordScreencastPress({ keys: 'C' }, false, document, 800);
    expect(texts()).toEqual(['C']);
  });

  it('超过 20 条清空重来(VSCode 同)', () => {
    for (let i = 0; i < 22; i++) recordScreencastPress({ keys: 'A' }, false, document, 800);
    expect(texts().length).toBeLessThanOrEqual(21);
  });

  it('关闭时不记录', () => {
    toggleScreencastMode();
    recordScreencastPress({ keys: 'A' }, false, document, 800);
    expect(texts()).toEqual([]);
  });
});

describe('浮层', () => {
  let registered: { dispose: () => void };
  beforeEach(() => {
    registered = coApp.commands.register(TOGGLE_SIDEBAR);
    toggleScreencastMode();
  });
  afterEach(() => registered.dispose());

  it('按键 → 底部浮层(aria-hidden、design KeyCap、字号 / 距底随设置);不在敏感输入里', async () => {
    const { container } = render(<ScreencastOverlay />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', [detectPlatform() === 'mac' ? 'metaKey' : 'ctrlKey']: true, bubbles: true }));
    });
    const overlay = document.querySelector<HTMLElement>('[data-screencast-keyboard]')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.dataset['visible']).toBe('true');
    expect(overlay.textContent).toContain('Toggle Sidebar');
    expect(overlay.querySelector('kbd.wm-keycap')).not.toBeNull();
    expect(overlay.style.fontSize).toBe('56px');
    expect(overlay.style.bottom).toBe('20%');
    expect(container.contains(overlay)).toBe(true);
  });

  it('鼠标按下处显示圆圈(以按下点为圆心),松开消失', () => {
    render(<ScreencastOverlay />);
    act(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 60, bubbles: true }));
    });
    const marker = document.querySelector<HTMLElement>('[data-screencast-mouse]')!;
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect([marker.style.left, marker.style.top, marker.style.width]).toEqual(['90px', '50px', '20px']);
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 60, bubbles: true }));
    });
    expect(marker.style.left).toBe('110px');
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(document.querySelector('[data-screencast-mouse]')).toBeNull();
  });

  it('样式:不接收指针、盖过对话框;淡出 0.3s,减弱动效时无过渡;颜色走 token,强制颜色用系统色', () => {
    const css = readFileSync(join(process.cwd(), 'src/shell/screencast/screencast.css'), 'utf8');
    expect(css).toMatch(/\.wm-screencast-keyboard \{[^}]*pointer-events: none;[^}]*z-index: var\(--z-screencast\)|z-index: var\(--z-screencast\);[^}]*pointer-events: none/);
    expect(css).toContain('transition: opacity 0.3s ease-out');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.wm-screencast-keyboard \{\s*transition: none;/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain('@media (forced-colors: active)');
  });
});

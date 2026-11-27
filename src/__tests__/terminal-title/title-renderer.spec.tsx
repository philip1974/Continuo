// @vitest-environment jsdom
// BDD: terminal-title / 2 renderer 不订阅 OSC 标题;4 终端 tab 右键「重命名…」与重命名框
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
  rename: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: h.onTitleChange,
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      focus: vi.fn(),
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })) }));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn().mockResolvedValue({ ok: true }),
      updateCwd: vi.fn().mockResolvedValue({ ok: true }),
      rename: h.rename,
      onData: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '@/panels/Terminal/useTerminal';
import { SharedTab } from '@/shell/motion/SharedTab';
import { TerminalRenameDialog } from '@/panels/Terminal/TerminalRenameDialog';
import { useTerminalRenameRequest } from '@/panels/Terminal/terminal-rename-request';
import { useTerminalStore } from '@/stores/terminal.store';
import { LABEL_MAX } from '../../../electron/shared/terminal-create';
import { setLocale } from '@/i18n';

beforeEach(() => {
  setLocale('zh');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  useTerminalRenameRequest.setState({ sessionId: null });
  useTerminalStore.setState({ sessions: [] });
  setLocale('en');
});

function Host() {
  const { containerRef } = useTerminal('term-t');
  return createElement('div', { ref: containerRef });
}

describe('OSC 0 / 2 标题', () => {
  it('不订阅 xterm onTitleChange(tab 标题不随程序 / 提示符设的标题变,VSCode 默认 ${process})', () => {
    render(createElement(Host));
    expect(h.onTitleChange).not.toHaveBeenCalled();
  });
});

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const labels = (): string[] => items().map((el) => el.textContent ?? '');

function renderTab(component: string, params: Record<string, unknown>) {
  const panel = { id: 'p1', params, view: { contentComponent: component }, api: { id: 'p1', close: vi.fn() } };
  const api = {
    id: 'p1',
    title: 'T',
    isActive: false,
    isVisible: false,
    group: { id: 'g1', api: { isMaximized: () => false }, panels: [panel] },
    close: panel.api.close,
    setActive: vi.fn(),
    onDidActiveChange: () => ({ dispose: vi.fn() }),
    onDidTitleChange: () => ({ dispose: vi.fn() }),
    onDidVisibilityChange: () => ({ dispose: () => {} }),
    onDidGroupChange: () => ({ dispose: vi.fn() }),
  };
  const props = {
    api,
    containerApi: { onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }), exitMaximizedGroup: vi.fn() },
    params,
  } as unknown as Parameters<typeof SharedTab>[0];
  const r = render(<SharedTab {...props} />);
  return { api, tab: r.getByRole('tab') };
}

describe('终端 tab 右键「重命名…」', () => {
  it('终端 tab 菜单首项是「重命名…」;选中 → 激活面板并请求该会话重命名', () => {
    const { api, tab } = renderTab('terminal', { sessionId: 'term-t' });
    fireEvent.contextMenu(tab);
    expect(labels()[0]).toBe('重命名…');
    fireEvent.click(items()[0]!);
    expect(api.setActive).toHaveBeenCalled();
    expect(useTerminalRenameRequest.getState().sessionId).toBe('term-t');
    // 菜单关闭不把焦点还给 tab(Radix 默认还原会抢走随后打开的重命名输入框的焦点;jsdom 不还原焦点,
    // 由 e2e terminal-links-title-keys「重命名」用例的 toBeFocused 守护)
  });
  it('非终端面板没有该项', () => {
    const { tab } = renderTab('explorer', {});
    fireEvent.contextMenu(tab);
    expect(labels()).not.toContain('重命名…');
  });
});

describe('重命名框', () => {
  function seed(extra: Record<string, unknown> = {}) {
    useTerminalStore.setState({
      sessions: [
        {
          id: 'term-t',
          title: 'Terminal 3',
          defaultTitleIndex: 3,
          cwd: '/w',
          originHint: 'user',
          createdAt: 1,
          exitCode: null,
          ownerWindowId: 1,
          ...extra,
        },
      ],
    });
  }
  const input = () => document.querySelector<HTMLInputElement>('[role=dialog] input')!;

  it('预填当前基础名;确定 → 去空白后重命名并关闭', () => {
    seed({ processName: 'vim' });
    const onClose = vi.fn();
    render(<TerminalRenameDialog sessionId="term-t" onClose={onClose} />);
    expect(input().value).toBe('vim');
    fireEvent.change(input(), { target: { value: '  构建  ' } });
    fireEvent.submit(input().form!);
    expect(h.rename).toHaveBeenCalledWith('term-t', '构建');
    expect(onClose).toHaveBeenCalled();
  });
  it('留空 → 清除重命名(回到自动标题)', () => {
    seed({ userTitle: '旧名' });
    render(<TerminalRenameDialog sessionId="term-t" onClose={vi.fn()} />);
    expect(input().value).toBe('旧名');
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.submit(input().form!);
    expect(h.rename).toHaveBeenCalledWith('term-t', '');
  });
  it('原样确定自动名 → 不固定(不发 IPC);Esc 取消不发 IPC', () => {
    seed();
    const onClose = vi.fn();
    render(<TerminalRenameDialog sessionId="term-t" onClose={onClose} />);
    expect(input().value).toBe('终端 3');
    fireEvent.submit(input().form!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(h.rename).not.toHaveBeenCalled();
  });
  it('输入框有可访问名(对话框标题)且长度封顶 LABEL_MAX', () => {
    seed();
    render(<TerminalRenameDialog sessionId="term-t" onClose={vi.fn()} />);
    const labelId = input().getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('重命名终端');
    expect(input().maxLength).toBe(LABEL_MAX);
  });
});

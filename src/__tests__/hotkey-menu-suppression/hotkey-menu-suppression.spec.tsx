// @vitest-environment jsdom
// BDD: hotkey-menu-suppression —— 菜单开着时不执行工作台快捷键;DropdownMenu 失焦即关、文档级 Esc。见同目录 README。
// jsdom detectPlatform() = 'other' → mod = Ctrl。
import * as Menu from '@radix-ui/react-context-menu';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuItem } from '../../design';
import { DropdownMenu } from '../../lib/dropdown-menu';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { trackPopoutDocuments } from '../../shell/dock/popout-documents';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';
import { runMenuCommand } from '../../shell/menu-commands';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { editorCommandSpecs } from '../../panels/Editor/editor-commands';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import type { DockviewApi } from 'dockview-react';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <div data-testid="code-editor" tabIndex={-1}>
      {value}
    </div>
  ),
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: { readFile: mocks.readFile, writeFile: mocks.writeFile, onDirChanged: vi.fn(() => vi.fn()) },
    shell: { openExternal: vi.fn() },
    window: { close: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

function press(target: Document | Element, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** 真 Radix 右键菜单(与资源管理器 / tab / 终端右键菜单同一原语):打开即 portal 到 body、焦点移入菜单。 */
function RadixMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <div data-testid="area">area</div>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item>item</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function workbench() {
  const reg = new CommandRegistry();
  const close = vi.fn();
  const focusFirst = vi.fn();
  reg.register({ id: 'workbench.action.closeActiveEditor', title: 'Close', hotkey: 'mod+w', fn: close });
  reg.register({ id: 'workbench.action.focusFirstEditorGroup', title: 'Focus 1', hotkey: 'mod+1', fn: focusFirst });
  renderHook(() => useCommandHotkeys(reg));
  return { reg, close, focusFirst };
}

beforeEach(() => {
  vi.clearAllMocks();
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  vi.restoreAllMocks();
  for (const frame of document.querySelectorAll('iframe')) frame.remove();
  act(() => useQuickOpenStore.getState().close());
});

describe('全局命令分发:按键落在打开的菜单里 → 不执行、不 preventDefault', () => {
  it('Radix 右键菜单开着:⌘W / ⌘1 不执行;菜单关闭后恢复', async () => {
    const { close, focusFirst } = workbench();
    render(<RadixMenu />);
    fireEvent.contextMenu(screen.getByTestId('area'));
    const menu = screen.getByRole('menu');
    expect(menu.contains(document.activeElement)).toBe(true);
    const ev = press(document.activeElement!, { key: 'w', ctrlKey: true });
    press(document.activeElement!, { key: '1', ctrlKey: true });
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(focusFirst).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    press(document.body, { key: 'w', ctrlKey: true });
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('popout 子窗里的菜单:子窗 ⌘W 不执行', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const popDoc = frame.contentDocument!;
    const noop = { dispose: () => {} };
    const group = { api: { location: { type: 'popout', getWindow: () => ({ document: popDoc }) }, onDidLocationChange: () => noop } };
    const tracker = trackPopoutDocuments({ groups: [group], onDidAddGroup: () => noop, onDidRemoveGroup: () => noop } as never);
    const { close } = workbench();
    render(
      createPortal(
        <div role="menu">
          <button type="button" role="menuitem">
            item
          </button>
        </div>,
        popDoc.body,
      ),
    );
    press(popDoc.querySelector('[role=menuitem]')!, { key: 'w', ctrlKey: true });
    await flush();
    expect(close).not.toHaveBeenCalled();
    press(popDoc.body, { key: 'w', ctrlKey: true });
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });
});

describe('Quick Open 开关键 / 应用菜单命令:焦点在菜单里 → 不执行', () => {
  it('⌘P 不打开 Quick Open', () => {
    renderHook(() => useQuickOpenHotkey());
    render(<RadixMenu />);
    fireEvent.contextMenu(screen.getByTestId('area'));
    act(() => void press(document.activeElement!, { key: 'p', ctrlKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
  });

  it('应用菜单 accelerator 回到 renderer(⌘O):焦点在菜单里不执行,菜单关闭后执行', () => {
    const reg = new CommandRegistry();
    const openFolder = vi.fn();
    reg.register({ id: 'workbench.action.files.openFolder', title: 'Open Folder', hotkey: 'mod+o', fn: openFolder });
    render(<RadixMenu />);
    fireEvent.contextMenu(screen.getByTestId('area'));
    runMenuCommand(reg, 'workbench.action.files.openFolder');
    expect(openFolder).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    runMenuCommand(reg, 'workbench.action.files.openFolder');
    expect(openFolder).toHaveBeenCalledTimes(1);
  });
});

describe('编辑器面板:tab 右键菜单里的按键(经 React 树冒泡到面板)不保存', () => {
  const A = '/work/a.ts';
  const tab = (path: string): EditorTab => ({ id: path, filePath: path, content: 'mine', originalContent: 'orig', dirty: true });

  it('右键菜单开着按 ⌘S:不写盘;菜单关闭后 ⌘S 照常保存', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
    mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
    useEditorStore.setState({ tabs: [tab(A)], activeTabId: A, mode: 'source' });
    setDockApi({ activePanel: { id: 'editor', view: { contentComponent: 'editor' }, api: { close: vi.fn() } } } as unknown as DockviewApi);
    const reg = new CommandRegistry(detectPlatform());
    for (const spec of editorCommandSpecs(detectPlatform())) reg.register(spec);
    function Hotkeys() {
      useCommandHotkeys(reg);
      return null;
    }
    render(
      <>
        <Hotkeys />
        <EditorPanel />
      </>,
    );
    const editor = await screen.findByTestId('code-editor');
    const tabEl = Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) => el.textContent?.startsWith('a.ts'))!;
    fireEvent.contextMenu(tabEl);
    const item = screen.getAllByRole('menuitem')[0]!;
    await act(async () => {
      fireEvent.keyDown(item, { key: 's', ctrlKey: true });
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();

    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });
});

// ── DropdownMenu 失焦关闭 / 文档级 Esc ─────────────────────────────────────────

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button type="button" ref={triggerRef} onClick={() => setOpen((v) => !v)}>
        trigger
      </button>
      <button type="button">outside</button>
      <DropdownMenu open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
        {() => (
          <>
            <MenuItem onClick={() => {}}>first</MenuItem>
            <MenuItem onClick={() => {}}>second</MenuItem>
          </>
        )}
      </DropdownMenu>
    </div>
  );
}

const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

async function openDropdown(): Promise<HTMLElement> {
  render(<Harness />);
  fireEvent.click(screen.getByText('trigger'));
  await frame();
  return screen.getByRole('menu');
}

describe('DropdownMenu:失焦即关', () => {
  it('焦点被移到菜单与触发按钮之外 → 关闭', async () => {
    await openDropdown();
    act(() => screen.getByText('outside').focus());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('焦点去了 body(被聚焦元素失焦)→ 关闭', async () => {
    await openDropdown();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('焦点在菜单项之间移动 / 落到菜单容器 / 回到触发按钮 → 不因失焦关闭', async () => {
    const menu = await openDropdown();
    act(() => screen.getByText('second').focus());
    act(() => menu.focus());
    expect(screen.getByRole('menu')).toBe(menu);
    act(() => screen.getByText('trigger').focus());
    expect(screen.getByRole('menu')).toBe(menu);
  });
});

describe('DropdownMenu:文档级 Esc', () => {
  it('焦点不在菜单里(未经失焦移走,如焦点仍在触发按钮)按 Esc → 关闭', async () => {
    await openDropdown();
    act(() => screen.getByText('trigger').focus());
    act(() => void press(document.body, { key: 'Escape' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('焦点在菜单内、事件未经菜单处理(如从 document 派发)→ 关闭并把焦点还给触发按钮', async () => {
    await openDropdown();
    act(() => void press(document, { key: 'Escape' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement?.textContent).toBe('trigger');
  });
});

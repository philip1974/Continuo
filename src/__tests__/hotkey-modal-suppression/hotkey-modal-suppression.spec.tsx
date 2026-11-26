// @vitest-environment jsdom
// BDD: hotkey-modal-suppression —— Modal 打开时不执行工作台快捷键(对齐 VSCode 对话框)。见同目录 README。
// jsdom detectPlatform() = 'other' → mod = Ctrl。
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal, hasOpenModalIn } from '../../design/Modal';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { trackPopoutDocuments } from '../../shell/dock/popout-documents';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';
import { useCommandPaletteHotkey } from '../../plugins/command-palette/useCommandPaletteHotkey';
import {
  isTerminalSearchHotkey,
  isTerminalZoomHotkey,
  terminalYieldedCommandId,
} from '../../panels/Terminal/terminal-hotkeys';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { closeActiveEditor, editorCommandSpecs } from '../../panels/Editor/editor-commands';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import type { DockviewApi } from 'dockview-react';
import { t } from '../../i18n';

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

function popoutDocument(): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentDocument!;
}

function trackAsPopout(doc: Document) {
  const noop = { dispose: () => {} };
  const group = { api: { location: { type: 'popout', getWindow: () => ({ document: doc }) }, onDidLocationChange: () => noop } };
  return trackPopoutDocuments({ groups: [group], onDidAddGroup: () => noop, onDidRemoveGroup: () => noop } as never);
}

function DialogInto({ container }: { readonly container?: Element }) {
  const modal = (
    <Modal visible onClose={() => {}}>
      <button type="button">confirm</button>
    </Modal>
  );
  return container ? createPortal(modal, container) : modal;
}

beforeEach(() => {
  vi.clearAllMocks();
  useKeybindingsStore.setState({ overrides: {} });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  vi.restoreAllMocks();
  for (const frame of document.querySelectorAll('iframe')) frame.remove();
  act(() => {
    useQuickOpenStore.getState().close();
    useCommandPaletteStore.getState().close();
  });
});

describe('hasOpenModalIn:按文档栈判定', () => {
  it('主窗打开 Modal → 主窗 true、子窗 false;besides 扣除调用方自己的 Modal', () => {
    const popDoc = popoutDocument();
    expect(hasOpenModalIn(document)).toBe(false);
    const view = render(<DialogInto />);
    expect(hasOpenModalIn(document)).toBe(true);
    expect(hasOpenModalIn(document, 1)).toBe(false);
    expect(hasOpenModalIn(popDoc)).toBe(false);
    view.unmount();
    expect(hasOpenModalIn(document)).toBe(false);
  });

  it('子窗里的 Modal 只计入子窗', () => {
    const popDoc = popoutDocument();
    render(<DialogInto container={popDoc.body} />);
    expect(hasOpenModalIn(popDoc)).toBe(true);
    expect(hasOpenModalIn(document)).toBe(false);
  });
});

describe('全局命令分发:Modal 打开时不执行、不 preventDefault', () => {
  function workbench() {
    const reg = new CommandRegistry();
    const newTerminal = vi.fn();
    const close = vi.fn();
    reg.register({ id: 'terminal.new', title: 'New Terminal', hotkey: 'mod+t', fn: newTerminal });
    reg.register({ id: 'workbench.action.closeActiveEditor', title: 'Close', hotkey: 'mod+w', fn: close });
    renderHook(() => useCommandHotkeys(reg));
    return { newTerminal, close };
  }

  it('确认框开着:⌘T / ⌘W 不执行,事件不被取消;关闭后恢复', async () => {
    const { newTerminal, close } = workbench();
    const view = render(<DialogInto />);
    const button = screen.getByRole('button', { name: 'confirm' });
    const ev = press(button, { key: 't', ctrlKey: true });
    press(document.body, { key: 'w', ctrlKey: true });
    await flush();
    expect(newTerminal).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);

    view.unmount();
    press(document.body, { key: 't', ctrlKey: true });
    await flush();
    expect(newTerminal).toHaveBeenCalledTimes(1);
  });

  it('popout 子窗:子窗有 Modal → 子窗 ⌘W 不执行;只有主窗有 Modal → 子窗 ⌘W 照常', async () => {
    const popDoc = popoutDocument();
    const tracker = trackAsPopout(popDoc);
    const { close } = workbench();
    const inPopout = render(<DialogInto container={popDoc.body} />);
    press(popDoc.body, { key: 'w', ctrlKey: true });
    await flush();
    expect(close).not.toHaveBeenCalled();
    inPopout.unmount();

    render(<DialogInto />);
    press(popDoc.body, { key: 'w', ctrlKey: true });
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });
});

describe('Quick Open / 命令面板开关键', () => {
  function PickerModals() {
    const quickOpen = useQuickOpenStore((s) => s.isOpen);
    const palette = useCommandPaletteStore((s) => s.isOpen);
    useQuickOpenHotkey();
    useCommandPaletteHotkey();
    return (
      <>
        <Modal visible={quickOpen} onClose={() => useQuickOpenStore.getState().close()}>
          <input aria-label="quick-open" />
        </Modal>
        <Modal visible={palette} onClose={() => useCommandPaletteStore.getState().close()}>
          <input aria-label="palette" />
        </Modal>
      </>
    );
  }

  it('picker 自己开着:⌘P 再按关闭;⌘⇧P 切到命令面板(互斥)', () => {
    render(<PickerModals />);
    act(() => void press(document.body, { key: 'p', ctrlKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    act(() => void press(screen.getByLabelText('quick-open'), { key: 'P', ctrlKey: true, shiftKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    act(() => void press(screen.getByLabelText('palette'), { key: 'P', ctrlKey: true, shiftKey: true }));
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('只有非 picker 的确认框开着:⌘P / ⌘⇧P 不打开 picker,不取消事件', () => {
    render(
      <>
        <PickerModals />
        <DialogInto />
      </>,
    );
    let ev!: KeyboardEvent;
    act(() => {
      ev = press(screen.getByRole('button', { name: 'confirm' }), { key: 'p', ctrlKey: true });
    });
    act(() => void press(document.body, { key: 'P', ctrlKey: true, shiftKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Quick Open 之上又弹出授权框:⌘⇧P 不切换、⌘P 不关闭背后的 Quick Open', () => {
    const view = render(<PickerModals />);
    act(() => void press(document.body, { key: 'p', ctrlKey: true }));
    view.rerender(
      <>
        <PickerModals />
        <DialogInto />
      </>,
    );
    act(() => void press(document.body, { key: 'P', ctrlKey: true, shiftKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    act(() => void press(document.body, { key: 'p', ctrlKey: true }));
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });
});

describe('终端让出:事件所在文档有 Modal → 不让出', () => {
  const noRegistry = { get: () => undefined, getAll: () => [] };
  it('关闭 / 保存 / 清屏 / 缩放 / 搜索均不让出', () => {
    const k = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    render(<DialogInto />);
    expect(terminalYieldedCommandId(k({ key: 'w', metaKey: true }), 'mac', {}, noRegistry)).toBeNull();
    expect(terminalYieldedCommandId(k({ key: 'k', metaKey: true }), 'mac', {}, noRegistry)).toBeNull();
    expect(isTerminalZoomHotkey(k({ key: 'Enter', metaKey: true, shiftKey: true }), 'mac', {})).toBe(false);
    expect(isTerminalSearchHotkey(k({ key: 'f', metaKey: true }), 'mac', {})).toBe(false);
    cleanup();
    expect(terminalYieldedCommandId(k({ key: 'w', metaKey: true }), 'mac', {}, noRegistry)).toBe(
      'workbench.action.closeActiveEditor',
    );
  });
});

describe('编辑器面板内的确认框:按键冒泡到面板也不保存 / 不切换', () => {
  const A = '/work/a.ts';
  const B = '/work/b.ts';
  const tab = (path: string, dirty = false): EditorTab => ({
    id: path,
    filePath: path,
    content: dirty ? 'mine' : 'orig',
    originalContent: 'orig',
    dirty,
  });

  it('「保存 / 不保存 / 取消」框开着:框内按 ⌘S 不写盘,按下一个编辑器不切 tab', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
    mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
    useEditorStore.setState({ tabs: [tab(A, true), tab(B)], activeTabId: A, mode: 'source' });
    setDockApi({ activePanel: { id: 'editor', view: { contentComponent: 'editor' }, api: { close: vi.fn(), location: { type: 'grid' } } } } as unknown as DockviewApi);
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
    await screen.findByTestId('code-editor');
    act(() => closeActiveEditor());
    const dialogTitle = screen.getByText(t('panels.editor.save_changes_title', { name: 'a.ts' }));
    const inDialog = dialogTitle.closest('.wm-modal-content')!.querySelector('button')!;
    await act(async () => {
      fireEvent.keyDown(inDialog, { key: 's', ctrlKey: true });
      fireEvent.keyDown(inDialog, { key: 'PageDown', ctrlKey: true });
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().activeTabId).toBe(A);
  });
});

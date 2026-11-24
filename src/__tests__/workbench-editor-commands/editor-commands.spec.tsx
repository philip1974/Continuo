// @vitest-environment jsdom
// BDD: workbench-editor-commands —— ⌘W 关闭当前编辑器 / ⌘S 全局保存 / 下一个·上一个编辑器。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import {
  closeActiveEditor,
  editorCommandSpecs,
  openAdjacentEditor,
  saveActiveEditor,
} from '../../panels/Editor/editor-commands';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { t } from '../../i18n';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  closeWindow: vi.fn(),
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
    fs: {
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
    window: { close: mocks.closeWindow },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const A = '/work/a.ts';
const B = '/work/b.ts';
const C = '/work/c.ts';

function tab(path: string, dirty = false): EditorTab {
  return { id: path, filePath: path, content: dirty ? 'mine' : 'orig', originalContent: 'orig', dirty };
}

interface FakePanel {
  readonly id: string;
  readonly view: { readonly contentComponent: string };
  readonly api: { readonly close: ReturnType<typeof vi.fn> };
}

function panel(id: string, component = id): FakePanel {
  return { id, view: { contentComponent: component }, api: { close: vi.fn() } };
}

function useDock(activePanel: FakePanel | null): void {
  setDockApi({ activePanel } as unknown as DockviewApi);
}

function Hotkeys({ registry }: { readonly registry: CommandRegistry }) {
  useCommandHotkeys(registry);
  return null;
}

function mountWorkbench() {
  const registry = new CommandRegistry(detectPlatform());
  for (const spec of editorCommandSpecs(detectPlatform())) registry.register(spec);
  render(
    <>
      <Hotkeys registry={registry} />
      <EditorPanel />
      <button type="button">explorer-row</button>
    </>,
  );
  return registry;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  mocks.closeWindow.mockResolvedValue({ ok: true, data: undefined });
  useEditorStore.setState({ tabs: [tab(A), tab(B)], activeTabId: A, mode: 'source' });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  vi.restoreAllMocks();
});

describe('workbench.action.closeActiveEditor(⌘W)', () => {
  it('活动面板是编辑器 → 只关当前干净文件 tab,不关面板、不关窗口', async () => {
    const editor = panel('editor');
    useDock(editor);
    mountWorkbench();
    await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('code-editor'), { key: 'w', ...MOD });
    });
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([B]);
    expect(editor.api.close).not.toHaveBeenCalled();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('当前 tab 脏 → 弹「保存 / 不保存 / 取消」,tab 保留(与 tab × 同一路径)', async () => {
    useEditorStore.setState({ tabs: [tab(A, true), tab(B)], activeTabId: A });
    useDock(panel('editor'));
    mountWorkbench();
    await screen.findByTestId('code-editor');
    act(() => closeActiveEditor());
    expect(screen.getByText(t('panels.editor.save_changes_title', { name: 'a.ts' }))).toBeTruthy();
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([A, B]);
  });

  it('活动面板是终端等其它面板 → 关闭该面板(走 panel.api.close),编辑器 tab 不动', async () => {
    const term = panel('terminal-1', 'terminal');
    useDock(term);
    mountWorkbench();
    await screen.findByTestId('code-editor');
    act(() => closeActiveEditor());
    expect(term.api.close).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([A, B]);
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('编辑器面板已无文件 tab → 关闭编辑器面板', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const editor = panel('editor');
    useDock(editor);
    mountWorkbench();
    act(() => closeActiveEditor());
    expect(editor.api.close).toHaveBeenCalledTimes(1);
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('没有可关的面板(无活动面板 / 无 dock)→ 关闭当前窗口', () => {
    useDock(null);
    closeActiveEditor();
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
    setDockApi(null);
    closeActiveEditor();
    expect(mocks.closeWindow).toHaveBeenCalledTimes(2);
  });
});

describe('workbench.action.files.save(⌘S)', () => {
  it('焦点在编辑器面板外(如 Explorer)→ 仍保存当前活动文件 tab', async () => {
    useEditorStore.setState({ tabs: [tab(A, true), tab(B)], activeTabId: A });
    mountWorkbench();
    await screen.findByTestId('code-editor');
    const outside = screen.getByRole('button', { name: 'explorer-row' });
    outside.focus();
    await act(async () => {
      fireEvent.keyDown(outside, { key: 's', ...MOD });
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(A, 'mine');
  });

  it('焦点在编辑器内 → 一次按键只保存一次(面板与全局分发不重复)', async () => {
    useEditorStore.setState({ tabs: [tab(A, true), tab(B)], activeTabId: A });
    mountWorkbench();
    const editor = await screen.findByTestId('code-editor');
    mocks.readFile.mockClear();
    await act(async () => {
      fireEvent.keyDown(editor, { key: 's', ...MOD });
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    // 每次保存先读盘比对一次:第二次保存会再读(且因 mock 磁盘仍是旧内容而误弹「仍然覆盖」)
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(t('panels.editor.disk_changed_title'))).toBeNull();
  });

  it('磁盘已被外部修改 → 命令路径同样弹「仍然覆盖」确认,不静默写', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs' });
    useEditorStore.setState({ tabs: [tab(A, true)], activeTabId: A });
    mountWorkbench();
    await screen.findByTestId('code-editor');
    await act(async () => {
      await saveActiveEditor();
    });
    expect(await screen.findByText(t('panels.editor.disk_changed_title'))).toBeTruthy();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});

describe('workbench.action.nextEditor / previousEditor', () => {
  it('在文件 tab 间循环切换,首尾相接', () => {
    useEditorStore.setState({ tabs: [tab(A), tab(B), tab(C)], activeTabId: B });
    openAdjacentEditor(1);
    expect(useEditorStore.getState().activeTabId).toBe(C);
    openAdjacentEditor(1);
    expect(useEditorStore.getState().activeTabId).toBe(A);
    openAdjacentEditor(-1);
    expect(useEditorStore.getState().activeTabId).toBe(C);
  });

  it('tab 数 < 2 → no-op', () => {
    useEditorStore.setState({ tabs: [tab(A)], activeTabId: A });
    const before = useEditorStore.getState();
    openAdjacentEditor(1);
    expect(useEditorStore.getState()).toBe(before);
  });

  it('编辑器面板内按下一个 / 上一个的生效绑定 → 切换本编辑器 tab(popout 内同样生效),只切一次', async () => {
    useEditorStore.setState({ tabs: [tab(A), tab(B), tab(C)], activeTabId: A });
    mountWorkbench();
    const editor = await screen.findByTestId('code-editor');
    const next = detectPlatform() === 'mac' ? { key: 'ArrowRight', metaKey: true, altKey: true } : { key: 'PageDown', ctrlKey: true };
    // 面板内就地处理并截住:popout 子窗不在全局分发的监听范围,只能靠面板自己处理;截住也保证主窗不重复切换。
    const reachedDocument = vi.fn();
    document.addEventListener('keydown', reachedDocument);
    await act(async () => {
      fireEvent.keyDown(editor, next);
    });
    document.removeEventListener('keydown', reachedDocument);
    expect(useEditorStore.getState().activeTabId).toBe(B);
    expect(reachedDocument).not.toHaveBeenCalled();
  });
});


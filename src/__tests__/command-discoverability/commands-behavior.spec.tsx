// @vitest-environment jsdom
// BDD: command-discoverability —— 新命令复用现有动作实现,作用于活动编辑器 / 工作区 / 活动面板;无上下文静默无操作。
// 见同目录 README 第 2 条。
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { editorCommandSpecs, registerEditorPanelActions } from '../../panels/Editor/editor-commands';
import { explorerCommandSpecs } from '../../panels/Explorer/explorer-commands';
import { onExplorerRequest, __resetExplorerRequestsForTest, type ExplorerRequest } from '../../panels/Explorer/explorer-requests';
import { windowCommandSpecs } from '../../shell/window-commands';
import { dockCommandSpecs } from '../../shell/dock/dock-panel-actions';
import { markDockLayoutRestored, setDockApi } from '../../shell/dock/dock-api-ref';
import { coApp } from '../../plugins/co-app';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  closeWindow: vi.fn(),
  viewAction: vi.fn(),
  copy: vi.fn(),
  reveal: vi.fn(),
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
    window: { close: mocks.closeWindow, viewAction: mocks.viewAction },
  },
}));
vi.mock('../../panels/Explorer/copy-to-clipboard', () => ({ copyToClipboardOrNotify: mocks.copy }));
vi.mock('../../panels/Explorer/reveal-or-notify', () => ({ revealPathOrNotify: mocks.reveal }));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const A = '/work/a.ts';
const B = '/work/b.ts';
const C = '/work/c.ts';
const MD = '/work/readme.md';

function tab(path: string, extra: Partial<EditorTab> = {}): EditorTab {
  const dirty = extra.dirty === true;
  return { id: path, filePath: path, content: dirty ? 'mine' : 'orig', originalContent: 'orig', dirty, ...extra };
}

const ALL_SPECS = [
  ...editorCommandSpecs(detectPlatform()),
  ...explorerCommandSpecs(),
  ...windowCommandSpecs(),
  ...dockCommandSpecs(),
];

async function run(id: string): Promise<void> {
  const spec = ALL_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`missing command ${id}`);
  await act(async () => {
    await spec.fn();
  });
}

const initialEditor = useEditorStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialEditor, true);
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.viewAction.mockResolvedValue({ ok: true, data: undefined });
  mocks.closeWindow.mockResolvedValue({ ok: true, data: undefined });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  __resetExplorerRequestsForTest();
  vi.restoreAllMocks();
});

describe('编辑器组关闭类命令(同 tab 右键)', () => {
  function withFakePanel(): ReturnType<typeof vi.fn> {
    const closeTabs = vi.fn();
    registerEditorPanelActions({ save: vi.fn(), saveAs: vi.fn(), closeActiveTab: vi.fn(() => true), closeTabs, saveTabForSaveAll: vi.fn(), confirmRevertLosingUndo: vi.fn(async () => true), confirmCloseDocs: vi.fn(async () => true) });
    return closeTabs;
  }

  it.each([
    ['workbench.action.closeOtherEditors', [A, C]],
    ['workbench.action.closeEditorsToTheRight', [C]],
    ['workbench.action.closeUnmodifiedEditors', [A, C]],
    ['workbench.action.closeEditorsInGroup', [A, B, C]],
  ] as const)('%s → 以活动 tab 为目标交给面板的批量关闭(脏确认在面板内)', async (id, expected) => {
    const closeTabs = withFakePanel();
    useEditorStore.setState({ tabs: [tab(A), tab(B, { dirty: true }), tab(C)], activeTabId: B });
    await run(id);
    expect(closeTabs).toHaveBeenCalledWith(expected);
  });

  it('无活动 tab → 静默无操作', async () => {
    const closeTabs = withFakePanel();
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await run('workbench.action.closeEditorsInGroup');
    expect(closeTabs).not.toHaveBeenCalled();
  });

  it('真实编辑器面板:关闭其他 → 只留活动 tab', async () => {
    useEditorStore.setState({ tabs: [tab(A), tab(B), tab(C)], activeTabId: B });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    await run('workbench.action.closeOtherEditors');
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([B]);
  });
});

describe('活动文件:复制路径 / 复制相对路径 / 在 Finder 中显示', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ root: '/work' });
  });

  it('复制路径 = 绝对路径;复制相对路径 = 相对工作区根', async () => {
    useEditorStore.setState({ tabs: [tab(A), tab('/work/src/b.ts')], activeTabId: '/work/src/b.ts' });
    await run('copyFilePath');
    expect(mocks.copy).toHaveBeenLastCalledWith('/work/src/b.ts', expect.any(String));
    await run('copyRelativeFilePath');
    expect(mocks.copy).toHaveBeenLastCalledWith('src/b.ts', expect.any(String));
  });

  it('在 Finder 中显示 → reveal 活动文件;文件已删除的 tab 不动', async () => {
    useEditorStore.setState({ tabs: [tab(A)], activeTabId: A });
    await run('revealFileInOS');
    expect(mocks.reveal).toHaveBeenCalledWith(A);
    mocks.reveal.mockClear();
    useEditorStore.setState({ tabs: [tab(A, { orphaned: true })], activeTabId: A });
    await run('revealFileInOS');
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it('无活动 tab → 静默无操作', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await run('copyFilePath');
    await run('copyRelativeFilePath');
    await run('revealFileInOS');
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
});

describe('Markdown 模式切换', () => {
  it('活动 tab 是 Markdown → 切到对应模式(走编辑器面板的模式切换)', async () => {
    useEditorStore.setState({ tabs: [tab(MD)], activeTabId: MD, mode: 'source' });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    await run('markdown.switchToPreviewMode');
    expect(useEditorStore.getState().mode).toBe('preview');
    await run('markdown.switchToSourceMode');
    expect(useEditorStore.getState().mode).toBe('source');
  });

  it('活动 tab 不是 Markdown → 不改模式', async () => {
    useEditorStore.setState({ tabs: [tab(A)], activeTabId: A, mode: 'source' });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    await run('markdown.switchToPreviewMode');
    expect(useEditorStore.getState().mode).toBe('source');
  });
});

describe('资源管理器:折叠 / 刷新 / 关闭文件夹', () => {
  it('有工作区 → 折叠 / 刷新请求发给文件树', async () => {
    useWorkspaceStore.setState({ root: '/work' });
    const seen: ExplorerRequest[] = [];
    const off = onExplorerRequest((r) => {
      seen.push(r);
      return true;
    });
    await run('workbench.files.action.collapseExplorerFolders');
    await run('workbench.files.action.refreshFilesExplorer');
    off();
    expect(seen.map((r) => r.kind)).toEqual(['collapseAll', 'refresh']);
  });

  it('无工作区 → 不发请求', async () => {
    useWorkspaceStore.setState({ root: null });
    const handler = vi.fn(() => true);
    const off = onExplorerRequest(handler);
    await run('workbench.files.action.collapseExplorerFolders');
    await run('workbench.files.action.refreshFilesExplorer');
    off();
    expect(handler).not.toHaveBeenCalled();
  });

  it('关闭文件夹 → 工作区回到未打开', async () => {
    useWorkspaceStore.setState({ root: '/work' });
    await run('workbench.action.closeFolder');
    expect(useWorkspaceStore.getState().root).toBeNull();
  });
});

describe('窗口类命令', () => {
  it('转到文件… → 打开 Quick Open', async () => {
    useQuickOpenStore.getState().close();
    await run('workbench.action.quickOpen');
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    useQuickOpenStore.getState().close();
  });

  it('关闭窗口 → coApi.window.close(关窗脏确认)', async () => {
    await run('workbench.action.closeWindow');
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['workbench.action.reloadWindow', 'reload'],
    ['workbench.action.toggleFullScreen', 'toggleFullScreen'],
  ] as const)('%s → window:view-action %s', async (id, action) => {
    await run(id);
    expect(mocks.viewAction).toHaveBeenCalledWith(action);
  });
});

describe('dock:显示输出 / 调试、弹出到独立窗口', () => {
  interface FakePanel {
    readonly id: string;
    readonly view: { readonly contentComponent: string };
    readonly group: { readonly api: { readonly location: { readonly type: string } } };
    readonly api: { readonly id: string; isActive: boolean; setActive: ReturnType<typeof vi.fn>; location: { type: string } };
  }
  function fakePanel(id: string, component: string, location = 'grid'): FakePanel {
    return {
      id,
      view: { contentComponent: component },
      group: { api: { location: { type: location } } },
      api: { id, isActive: false, setActive: vi.fn(), location: { type: location } },
    };
  }
  function useDock(panels: FakePanel[], activePanel: FakePanel | null = null) {
    const api = {
      panels,
      activePanel,
      activeGroup: undefined,
      groups: [],
      getPanel: (id: string) => panels.find((p) => p.id === id),
      addPanel: vi.fn(),
      addPopoutGroup: vi.fn(() => Promise.resolve(true)),
    };
    setDockApi(api as unknown as DockviewApi);
    markDockLayoutRestored(api as unknown as DockviewApi);
    return api;
  }

  let disposeOutput: (() => void) | undefined;
  beforeEach(() => {
    const registration = coApp.panels.register({
      type: 'output',
      title: 'Output',
      titleKey: 'panels.output.title',
      multiInstance: true,
      factory: () => null,
    });
    disposeOutput = () => registration.dispose();
  });
  afterEach(() => {
    disposeOutput?.();
  });

  it('已有输出面板 → 激活它,不新建', async () => {
    const out = fakePanel('output-3', 'output');
    const dock = useDock([out]);
    await run('workbench.view.output');
    expect(out.api.setActive).toHaveBeenCalled();
    expect(dock.addPanel).not.toHaveBeenCalled();
  });

  it('没有 → 新建一个(同 dock「⋯」菜单)', async () => {
    const dock = useDock([]);
    await run('workbench.view.output');
    expect(dock.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'output', params: { titleKey: 'panels.output.title' } }),
    );
  });

  it('弹出到独立窗口 → 弹出活动面板所在组;活动组已在子窗 / 无活动面板 → 无操作', async () => {
    const term = fakePanel('terminal-1', 'terminal');
    let dock = useDock([term], term);
    await run('workbench.action.moveEditorGroupToNewWindow');
    expect(dock.addPopoutGroup).toHaveBeenCalledWith(term, expect.objectContaining({ popoutUrl: expect.any(String) }));

    const inPopout = fakePanel('terminal-2', 'terminal', 'popout');
    dock = useDock([inPopout], inPopout);
    await run('workbench.action.moveEditorGroupToNewWindow');
    expect(dock.addPopoutGroup).not.toHaveBeenCalled();

    dock = useDock([], null);
    await run('workbench.action.moveEditorGroupToNewWindow');
    expect(dock.addPopoutGroup).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
// 停下时自动定位:用户自己的调试操作引起的停下 → 焦点进停止位置编辑器(VSCode focusEditorOnBreak);agent 引起的 → 不抢焦点、
// 不盖住焦点所在的面板 / 编辑器(改投另一个编辑器组后台打开,或不打开);因断点停下时显示调试视图;只定位最新一停;快照恢复的停点不定位。
// 调试视图是侧栏型面板(不和编辑器同组)。见同目录 README。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Stack = { ok: true; data: { frames: Array<{ id: number; name: string; source_path?: string; line: number }>; scopes: [] } };
const h = vi.hoisted(() => ({
  events: [] as Array<(event: unknown) => void>,
  stacks: [] as Array<(value: Stack) => void>,
  subscribeData: { sessions: [] as unknown[] },
  openFileInEditor: vi.fn(async () => ({ ok: true, lineApplied: true })),
  openFileByPath: vi.fn(async () => ({ ok: true, data: undefined })),
  revealPanel: vi.fn(),
  control: vi.fn(async () => ({ ok: true, data: {} })),
  dockApi: null as unknown,
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    debug: {
      onEvent: vi.fn((cb: (event: unknown) => void) => {
        h.events.push(cb);
        return () => undefined;
      }),
      subscribe: vi.fn(async () => ({ ok: true, data: h.subscribeData })),
      getStack: vi.fn(() => new Promise<Stack>((resolve) => h.stacks.push(resolve))),
      control: h.control,
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({ openFileInEditor: h.openFileInEditor }));
vi.mock('@/shell/dock/dock-panel-actions', () => ({
  revealPanelOfTypeWithoutFocus: h.revealPanel,
  dockPanelContaining: (api: { panels: FakePanel[] }, el: Element | null) =>
    el === null || el === document.body ? undefined : api.panels.find((p) => p.view.content.element.contains(el)),
}));
vi.mock('@/shell/dock/dock-api-ref', () => ({ getDockApi: () => h.dockApi }));
vi.mock('@/panels/Editor/editor-file-actions', () => ({ openFileByPath: h.openFileByPath }));

interface FakeGroup {
  activePanel: FakePanel | undefined;
}
interface FakePanel {
  readonly id: string;
  readonly group: FakeGroup;
  readonly view: { readonly content: { readonly element: HTMLElement } };
}

/** 假 dock:groups = 每个 dock 组的面板 id(首个为该组显示的面板)。返回各面板的内容元素。 */
function fakeDock(groups: readonly (readonly string[])[]): Record<string, HTMLElement> {
  const panels: FakePanel[] = [];
  const elements: Record<string, HTMLElement> = {};
  for (const ids of groups) {
    const group: FakeGroup = { activePanel: undefined };
    for (const id of ids) {
      const element = document.createElement('div');
      const input = document.createElement('textarea');
      element.append(input);
      document.body.append(element);
      elements[id] = element;
      const panel = { id, group, view: { content: { element } } };
      group.activePanel ??= panel;
      panels.push(panel);
    }
  }
  h.dockApi = { panels, getPanel: (id: string) => panels.find((p) => p.id === id) };
  return elements;
}

import { startDebugAutoReveal } from '../../panels/Debug/debug-auto-reveal';
import { resetDebugStoreForTest, startDebugStoreSync, useDebugStore } from '../../stores/debug.store';
import { useEditorStore } from '../../stores/editor.store';
import { isSidePanelId, isSidePanelType, sidePanelAddPosition, SIDE_PANEL_POSITION } from '../../shell/dock/side-panel';
import { flushMicrotasks } from '../_helpers/async';

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  resetDebugStoreForTest();
  h.events = [];
  h.stacks = [];
  h.subscribeData = { sessions: [] };
  h.dockApi = null;
  useEditorStore.setState({ groups: [{ id: 'editor', tabIds: [], activeTabId: null }], activeGroupId: 'editor' });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const stack = (file: string | undefined, line: number): Stack => ({
  ok: true,
  data: { frames: [{ id: 1, name: 'f', ...(file !== undefined ? { source_path: file } : {}), line }], scopes: [] },
});

function start(): (event: unknown) => void {
  startDebugStoreSync();
  stop = startDebugAutoReveal();
  return h.events[0]!;
}

describe('停下时自动定位', () => {
  it('因断点停下:栈帧到达后显示调试视图(不聚焦)并以预览方式打开停止位置、不抢焦点', async () => {
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    expect(h.openFileInEditor).not.toHaveBeenCalled(); // 等栈帧
    h.stacks[0]!(stack('/repo/app.js', 12));
    await flushMicrotasks();
    expect(h.revealPanel).toHaveBeenCalledWith('debug', { keepFocusedVisible: true });
    expect(h.openFileInEditor).toHaveBeenCalledWith(
      '/repo/app.js',
      { line: 12 },
      { preview: true },
      { clampToDocument: true, preserveFocus: true },
    );
  });

  it('单步 / 暂停停下:定位位置,但不打开调试视图(VSCode openOnDebugBreak 只在断点时)', async () => {
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    h.stacks[0]!(stack('/repo/app.js', 13));
    await flushMicrotasks();
    expect(h.openFileInEditor).toHaveBeenCalledTimes(1);
    expect(h.revealPanel).not.toHaveBeenCalled();
  });

  it('快速连续停下:旧停的栈帧迟到不定位,只定位最新一停;继续运行后到达的不定位', async () => {
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    emit({ type: 'continued', sessionId: 's1' });
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    h.stacks[1]!(stack('/repo/app.js', 20));
    await flushMicrotasks();
    h.stacks[0]!(stack('/repo/app.js', 10));
    await flushMicrotasks();
    expect(h.openFileInEditor).toHaveBeenCalledTimes(1);
    expect(h.openFileInEditor).toHaveBeenCalledWith('/repo/app.js', { line: 20 }, expect.anything(), expect.anything());

    emit({ type: 'stopped', sessionId: 's1', stopSeq: 3, reason: 'step' });
    emit({ type: 'continued', sessionId: 's1' });
    h.stacks[2]!(stack('/repo/app.js', 30));
    await flushMicrotasks();
    expect(h.openFileInEditor).toHaveBeenCalledTimes(1);
  });

  it('无源码路径 / 非绝对路径的首帧不打开;subscribe 快照恢复的停点不定位', async () => {
    h.subscribeData = { sessions: [{ session_id: 's0', breakpointsBySource: [], stop: { stopSeq: 4, reason: 'breakpoint' } }] };
    const emit = start();
    await flushMicrotasks();
    h.stacks[0]!(stack('/repo/restored.js', 1));
    await flushMicrotasks();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    h.stacks[1]!(stack('node:internal/timers', 5));
    await flushMicrotasks();
    expect(h.openFileInEditor).not.toHaveBeenCalled();
  });

  it('打开期间焦点被挪到编辑器 → 还给原来的元素(用户正在别处打字)', async () => {
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.tabIndex = 0;
    editor.append(content);
    document.body.append(input, editor);
    input.focus();
    h.openFileInEditor.mockImplementationOnce(async () => {
      content.focus();
      return { ok: true, lineApplied: true };
    });
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    h.stacks[0]!(stack('/repo/app.js', 2));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(document.activeElement).toBe(input);
    document.body.replaceChildren();
  });
});

describe('用户自己的调试操作引起的停下(VSCode debug.focusEditorOnBreak)', () => {
  it('F10 / 工具栏单步后的停下:打开停止位置并把焦点交给编辑器(不带 preserveFocus);调试视图照常显示(可换组内 tab)', async () => {
    const emit = start();
    void useDebugStore.getState().control('s1', 'stepOver');
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    h.stacks[0]!(stack('/repo/app.js', 7));
    await flushMicrotasks();
    expect(h.openFileInEditor).toHaveBeenCalledWith('/repo/app.js', { line: 7 }, { preview: true }, { clampToDocument: true });
    expect(h.revealPanel).toHaveBeenCalledWith('debug', undefined);
  });

  it('只算发出操作后的下一停;之后 agent 驱动的停下不再算用户的;发送失败不算', async () => {
    const emit = start();
    void useDebugStore.getState().control('s1', 'pause');
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'pause' });
    expect(useDebugStore.getState().lastLiveStop?.byUser).toBe(true);
    emit({ type: 'continued', sessionId: 's1' });
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 2, reason: 'step' });
    expect(useDebugStore.getState().lastLiveStop?.byUser).toBe(false);
    h.control.mockResolvedValueOnce({ ok: false, code: 'X', message: 'x' } as never);
    await useDebugStore.getState().control('s1', 'continue');
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 3, reason: 'breakpoint' });
    expect(useDebugStore.getState().lastLiveStop?.byUser).toBe(false);
  });
});

describe('agent 引起的停下不盖住用户焦点所在的面板 / 编辑器', () => {
  it('用户正在活动编辑器组里打字、没有别的编辑器组:不打开(lib.js 不被换下,焦点留在原处)', async () => {
    const el = fakeDock([['editor'], ['terminal-1']]);
    const typing = el.editor!.querySelector('textarea')!;
    typing.focus();
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    h.stacks[0]!(stack('/repo/app.js', 3));
    await flushMicrotasks();
    expect(h.openFileInEditor).not.toHaveBeenCalled();
    expect(h.openFileByPath).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(typing);
  });

  it('终端与编辑器在同一 dock 组、焦点在终端:不打开(「编辑器」面板不盖住终端)', async () => {
    const el = fakeDock([['terminal-1', 'editor']]);
    el['terminal-1']!.querySelector('textarea')!.focus();
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    h.stacks[0]!(stack('/repo/app.js', 3));
    await flushMicrotasks();
    expect(h.openFileInEditor).not.toHaveBeenCalled();
    expect(h.openFileByPath).not.toHaveBeenCalled();
  });

  it('会盖住时改投另一个正在显示、不与焦点面板同组的编辑器组,后台打开(不换活动组、不聚焦)', async () => {
    useEditorStore.setState({
      groups: [
        { id: 'editor', tabIds: [], activeTabId: null },
        { id: 'editor:2', tabIds: [], activeTabId: null },
        { id: 'editor:3', tabIds: [], activeTabId: null },
      ],
      activeGroupId: 'editor',
    });
    // editor:2 与焦点所在的 editor 同一 dock 组(被盖着)→ 跳过;editor:3 在另一个 dock 组且正显示 → 选它
    const el = fakeDock([['editor', 'editor:2'], ['editor:3']]);
    el.editor!.querySelector('textarea')!.focus();
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    h.stacks[0]!(stack('/repo/app.js', 3));
    await flushMicrotasks();
    expect(h.openFileInEditor).not.toHaveBeenCalled();
    expect(h.openFileByPath).toHaveBeenCalledWith('/repo/app.js', expect.anything(), {
      preview: true,
      groupId: 'editor:3',
      requestFocus: false,
    });
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
  });

  it('焦点所在面板与活动编辑器组不同组:照旧在活动组打开(不抢焦点)', async () => {
    const el = fakeDock([['editor'], ['terminal-1']]);
    el['terminal-1']!.querySelector('textarea')!.focus();
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    h.stacks[0]!(stack('/repo/app.js', 3));
    await flushMicrotasks();
    expect(h.openFileInEditor).toHaveBeenCalledWith(
      '/repo/app.js',
      { line: 3 },
      { preview: true },
      { clampToDocument: true, preserveFocus: true },
    );
  });

  it('焦点仍丢到了 body(原元素被卸载)→ 交给停止位置的编辑器,不让按键落空', async () => {
    const el = fakeDock([['editor'], ['terminal-1']]);
    const typing = el['terminal-1']!.querySelector('textarea')!;
    typing.focus();
    const stopEditor = document.createElement('div');
    stopEditor.tabIndex = -1;
    document.body.append(stopEditor);
    const focus = vi.fn(() => stopEditor.focus());
    useEditorStore.setState({ activeTabId: 't1', viewRefs: new Map([['t1', { focus } as never]]) });
    h.openFileInEditor.mockImplementationOnce(async () => {
      typing.remove();
      return { ok: true, lineApplied: true };
    });
    const emit = start();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'step' });
    h.stacks[0]!(stack('/repo/app.js', 3));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(focus).toHaveBeenCalled();
    expect(document.activeElement).toBe(stopEditor);
    useEditorStore.setState({ activeTabId: null, viewRefs: new Map() });
  });
});

describe('调试视图是侧栏型面板', () => {
  it('debug / debug-<n> 是侧栏面板;新建落点:已有侧栏组 → 加进去,否则最左侧', () => {
    expect(isSidePanelId('debug-3')).toBe(true);
    expect(isSidePanelId('debug')).toBe(true);
    expect(isSidePanelId('debugger-x')).toBe(false);
    expect(isSidePanelType('debug')).toBe(true);
    const sideGroup = { api: { location: { type: 'grid' } }, panels: [{ id: 'search' }] };
    const editorGroup = { api: { location: { type: 'grid' } }, panels: [{ id: 'editor' }] };
    expect(sidePanelAddPosition({ groups: [editorGroup, sideGroup] } as never)).toEqual({
      referenceGroup: sideGroup,
      direction: 'within',
    });
    expect(sidePanelAddPosition({ groups: [editorGroup] } as never)).toBe(SIDE_PANEL_POSITION);
  });
});

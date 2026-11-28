// @vitest-environment jsdom
// 停下时自动定位:打开停止位置不抢焦点;因断点停下时显示调试视图;只定位最新一停;快照恢复的停点不定位。
// 调试视图是侧栏型面板(不和编辑器同组)。见同目录 README。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Stack = { ok: true; data: { frames: Array<{ id: number; name: string; source_path?: string; line: number }>; scopes: [] } };
const h = vi.hoisted(() => ({
  events: [] as Array<(event: unknown) => void>,
  stacks: [] as Array<(value: Stack) => void>,
  subscribeData: { sessions: [] as unknown[] },
  openFileInEditor: vi.fn(async () => ({ ok: true, lineApplied: true })),
  revealPanel: vi.fn(),
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
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({ openFileInEditor: h.openFileInEditor }));
vi.mock('@/shell/dock/dock-panel-actions', () => ({ revealPanelOfTypeWithoutFocus: h.revealPanel }));

import { startDebugAutoReveal } from '../../panels/Debug/debug-auto-reveal';
import { resetDebugStoreForTest, startDebugStoreSync } from '../../stores/debug.store';
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
    expect(h.revealPanel).toHaveBeenCalledWith('debug');
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

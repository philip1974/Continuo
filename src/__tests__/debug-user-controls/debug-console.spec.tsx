// @vitest-environment jsdom
// 调试控制台:output 事件进 store(上限)、分色显示、求值、会话结束后保留;user-breakpoints-changed / started 入 store。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DebugViewEvent } from '../../../electron/shared/debug-view-channels';
import { DEBUG_VIEW_OUTPUT_ENTRIES_MAX } from '../../../electron/shared/debug-view-channels';

const h = vi.hoisted(() => ({
  events: [] as Array<(event: unknown) => void>,
  subscribeData: { sessions: [] as unknown[], userBreakpoints: [] as unknown[] },
  evaluate: vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true as const, data: { result: '3', truncated: false } })),
  getVariables: vi.fn(async (_input: unknown): Promise<unknown> => ({
    ok: true as const,
    data: { variables: [{ name: 'a', value: '1' }, { name: 'b', value: '"x"' }] },
  })),
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    debug: {
      onEvent: vi.fn((cb: (event: unknown) => void) => {
        h.events.push(cb);
        return () => undefined;
      }),
      subscribe: vi.fn(async () => ({ ok: true, data: h.subscribeData })),
      getStack: vi.fn(async () => ({
        ok: true,
        data: { frames: [{ id: 7, name: 'main', source_path: '/repo/a.js', line: 3 }], scopes: [] },
      })),
      getVariables: h.getVariables,
      control: vi.fn(),
      evaluate: h.evaluate,
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({
  coApp: {
    editor: { openFile: vi.fn() },
    commands: { getAll: () => [], get: () => undefined, subscribe: () => () => undefined },
  },
}));

import { DebugPanel, resetDebugConsoleHistoryForTest } from '../../panels/Debug/DebugPanel';
import { resetDebugStoreForTest, startDebugStoreSync, useDebugStore } from '../../stores/debug.store';
import { setLocale } from '../../i18n';
import { flushMicrotasks } from '../_helpers/async';

const emit = (event: DebugViewEvent | Record<string, unknown>) => act(() => h.events[0]!(event));

afterEach(() => {
  cleanup();
  resetDebugConsoleHistoryForTest();
  resetDebugStoreForTest();
  h.events = [];
  h.subscribeData = { sessions: [], userBreakpoints: [] };
  vi.clearAllMocks();
});

function openConsole(): void {
  render(<DebugPanel />);
  fireEvent.click(screen.getByRole('tab', { name: 'Debug Console' }));
}

describe('调试控制台', () => {
  it('started 建出会话(运行中);output 按到达顺序显示,stderr 错误色、console 警告色', async () => {
    setLocale('en');
    startDebugStoreSync();
    emit({ type: 'started', sessionId: 's1', label: 'app.js' });
    emit({
      type: 'output',
      sessionId: 's1',
      entries: [
        { seq: 0, category: 'stdout', output: 'hello\n' },
        { seq: 1, category: 'stderr', output: 'boom\n' },
        { seq: 2, category: 'console', output: 'Debugger attached.\n' },
      ],
    });
    openConsole();
    const log = screen.getByRole('log', { name: 'Debug console output' });
    const lines = Array.from(log.querySelectorAll('[data-category]'));
    expect(lines.map((el) => el.textContent)).toEqual(['hello', 'boom', 'Debugger attached.']);
    expect(lines[1]!.className).toMatch(/text-error/);
    expect(lines[2]!.className).toMatch(/text-warning/);
    expect(lines[0]!.className).toMatch(/text-fg/);
  });

  it('stderr / console 行另有非颜色线索:左侧竖条 stderr 实线、console 虚线,stdout 透明占位(色觉差异 / 强制颜色下可辨)', () => {
    setLocale('en');
    startDebugStoreSync();
    emit({ type: 'started', sessionId: 's1' });
    emit({
      type: 'output',
      sessionId: 's1',
      entries: [
        { seq: 0, category: 'stdout', output: 'out\n' },
        { seq: 1, category: 'stderr', output: 'err\n' },
        { seq: 2, category: 'console', output: 'note\n' },
      ],
    });
    openConsole();
    const [out, err, note] = Array.from(screen.getByRole('log').querySelectorAll('[data-category]')).map((el) =>
      el.className.split(/\s+/),
    );
    for (const cls of [out!, err!, note!]) expect(cls).toContain('border-l-2');
    expect(err).toEqual(expect.arrayContaining(['border-solid', 'border-error']));
    expect(note).toEqual(expect.arrayContaining(['border-dashed', 'border-warning']));
    expect(out).toContain('border-transparent');
    expect(out).not.toContain('border-solid');
    expect(out).not.toContain('border-dashed');
  });

  it('只保留最近 DEBUG_VIEW_OUTPUT_ENTRIES_MAX 行,并提示更早的未显示;未知会话的 output 不建会话', () => {
    startDebugStoreSync();
    emit({ type: 'output', sessionId: 'ghost', entries: [{ seq: 0, category: 'stdout', output: 'x' }] });
    expect(useDebugStore.getState().sessions.has('ghost')).toBe(false);
    emit({ type: 'started', sessionId: 's1' });
    const entries = Array.from({ length: DEBUG_VIEW_OUTPUT_ENTRIES_MAX + 5 }, (_, i) => ({
      seq: i,
      category: 'stdout',
      output: `line ${i}`,
    }));
    emit({ type: 'output', sessionId: 's1', entries });
    const consoleLines = useDebugStore.getState().sessions.get('s1')!.console!;
    expect(consoleLines).toHaveLength(DEBUG_VIEW_OUTPUT_ENTRIES_MAX);
    openConsole();
    expect(screen.getByText('Earlier output is not shown')).toBeTruthy();
  });

  it('输入表达式 Enter 求值:输入与结果追加到控制台;停住时带首帧 id', async () => {
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await act(flushMicrotasks);
    openConsole();
    const input = screen.getByRole('textbox', { name: 'Evaluate expression' });
    fireEvent.change(input, { target: { value: '1 + 2' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await flushMicrotasks();
    });
    expect(h.evaluate).toHaveBeenCalledWith({ sessionId: 's1', expression: '1 + 2', frameId: 7 });
    const lines = Array.from(screen.getByRole('log').querySelectorAll('[data-category]'));
    expect(lines.map((el) => [el.getAttribute('data-category'), el.textContent])).toEqual([
      ['input', '› 1 + 2'],
      ['result', '3'],
    ]);
  });

  it('会话结束后保留其控制台(标「已结束」),直到下一个会话 started', () => {
    startDebugStoreSync();
    emit({ type: 'started', sessionId: 's1', label: 'app.js' });
    emit({ type: 'output', sessionId: 's1', entries: [{ seq: 0, category: 'stdout', output: 'done\n' }] });
    emit({ type: 'terminated', sessionId: 's1' });
    openConsole();
    expect(screen.getByText('ended')).toBeTruthy();
    expect(screen.getByRole('log').textContent).toContain('done');
    // 结束的会话没有输入框
    expect(screen.queryByRole('textbox')).toBeNull();
    emit({ type: 'started', sessionId: 's2', label: 'next.js' });
    expect(useDebugStore.getState().endedConsole).toBeNull();
  });

  it('user-breakpoints-changed 整表替换;subscribe 快照恢复用户断点与最近输出', async () => {
    h.subscribeData = {
      sessions: [{ session_id: 's1', breakpointsBySource: [], output: [{ seq: 0, category: 'stdout', output: 'old\n' }] }],
      userBreakpoints: [{ file: '/repo/a.js', line: 2 }, { file: 'bad' }],
    };
    startDebugStoreSync();
    await act(flushMicrotasks);
    expect(useDebugStore.getState().userBreakpoints).toEqual([{ file: '/repo/a.js', line: 2 }]);
    expect(useDebugStore.getState().sessions.get('s1')!.console!.map((l) => l.text)).toEqual(['old\n']);
    emit({ type: 'user-breakpoints-changed', breakpoints: [{ file: '/repo/b.js', line: 9 }] });
    expect(useDebugStore.getState().userBreakpoints).toEqual([{ file: '/repo/b.js', line: 9 }]);
  });
});

describe('调试控制台 REPL(VSCode Debug Console)', () => {
  async function submit(input: HTMLElement, text: string): Promise<void> {
    fireEvent.change(input, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await flushMicrotasks();
    });
  }

  it('↑ / ↓ 翻输入历史:↑ 上一条(到最早一条停住),↓ 下一条,过了最新一条清空;连续重复只记一次', async () => {
    startDebugStoreSync();
    emit({ type: 'started', sessionId: 's1' });
    openConsole();
    const input = screen.getByRole('textbox', { name: 'Evaluate expression' }) as HTMLInputElement;
    await submit(input, 'a');
    await submit(input, 'b');
    await submit(input, 'b');
    const key = (k: string) => fireEvent.keyDown(input, { key: k });
    key('ArrowUp');
    expect(input.value).toBe('b');
    key('ArrowUp');
    expect(input.value).toBe('a');
    key('ArrowUp');
    expect(input.value).toBe('a');
    key('ArrowDown');
    expect(input.value).toBe('b');
    key('ArrowDown');
    expect(input.value).toBe('');
  });

  it('对象结果可展开(variablesReference,子变量懒加载);继续运行后不再可展开', async () => {
    h.evaluate.mockResolvedValueOnce({ ok: true, data: { result: 'Object', variables_reference: 42 } });
    startDebugStoreSync();
    emit({ type: 'stopped', sessionId: 's1', stopSeq: 1, reason: 'breakpoint' });
    await act(flushMicrotasks);
    openConsole();
    await submit(screen.getByRole('textbox', { name: 'Evaluate expression' }), 'obj');
    const node = screen.getByRole('treeitem', { name: 'Object' });
    expect(node.getAttribute('aria-expanded')).toBe('false');
    expect(h.getVariables).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(node);
      await flushMicrotasks();
    });
    expect(h.getVariables).toHaveBeenCalledWith({ sessionId: 's1', variablesReference: 42 });
    expect(screen.getByRole('treeitem', { name: 'a: 1' })).toBeTruthy();
    emit({ type: 'continued', sessionId: 's1' });
    expect(screen.queryByRole('treeitem')).toBeNull();
    expect(screen.getByRole('log').textContent).toContain('Object');
  });

  it('「清除控制台」按钮清空当前会话的控制台;mac 上焦点在控制台时 ⌘K 同样清除,且不冒泡给全局(终端 ⌘K)', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    startDebugStoreSync();
    emit({ type: 'started', sessionId: 's1' });
    emit({ type: 'output', sessionId: 's1', entries: [{ seq: 0, category: 'stdout', output: 'hello\n' }] });
    openConsole();
    const clear = screen.getByRole('button', { name: 'Clear Console' });
    expect(clear.getAttribute('title')).toBe('Clear Console (⌘K)');
    fireEvent.click(clear);
    expect(useDebugStore.getState().sessions.get('s1')!.console).toEqual([]);
    expect(screen.getByRole('log').textContent).toContain('No output');

    emit({ type: 'output', sessionId: 's1', entries: [{ seq: 1, category: 'stdout', output: 'again\n' }] });
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Evaluate expression' }), { key: 'k', metaKey: true });
    document.removeEventListener('keydown', outer);
    expect(useDebugStore.getState().sessions.get('s1')!.console).toEqual([]);
    expect(outer).not.toHaveBeenCalled();
    platform.mockRestore();
  });

  it('会话结束后保留的控制台也可清除', () => {
    startDebugStoreSync();
    emit({ type: 'started', sessionId: 's1' });
    emit({ type: 'output', sessionId: 's1', entries: [{ seq: 0, category: 'stdout', output: 'done\n' }] });
    emit({ type: 'terminated', sessionId: 's1' });
    openConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Console' }));
    expect(useDebugStore.getState().endedConsole!.lines).toEqual([]);
  });
});

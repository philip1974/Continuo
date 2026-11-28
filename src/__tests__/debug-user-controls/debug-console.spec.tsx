// @vitest-environment jsdom
// 调试控制台:output 事件进 store(上限)、分色显示、求值、会话结束后保留;user-breakpoints-changed / started 入 store。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DebugViewEvent } from '../../../electron/shared/debug-view-channels';
import { DEBUG_VIEW_OUTPUT_ENTRIES_MAX } from '../../../electron/shared/debug-view-channels';

const h = vi.hoisted(() => ({
  events: [] as Array<(event: unknown) => void>,
  subscribeData: { sessions: [] as unknown[], userBreakpoints: [] as unknown[] },
  evaluate: vi.fn(async () => ({ ok: true as const, data: { result: '3', truncated: false } })),
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
      getVariables: vi.fn(),
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

import { DebugPanel } from '../../panels/Debug/DebugPanel';
import { resetDebugStoreForTest, startDebugStoreSync, useDebugStore } from '../../stores/debug.store';
import { setLocale } from '../../i18n';
import { flushMicrotasks } from '../_helpers/async';

const emit = (event: DebugViewEvent | Record<string, unknown>) => act(() => h.events[0]!(event));

afterEach(() => {
  cleanup();
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

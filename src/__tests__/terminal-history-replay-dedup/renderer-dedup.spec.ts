// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  writes: [] as string[],
  onDataHandler: null as null | ((data: string, offset?: number) => void),
  historyDeferred: null as null | {
    promise: Promise<unknown>;
    resolve: (v: unknown) => void;
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options: {},
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      write: vi.fn((d: string) => hoisted.writes.push(d)),
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn().mockResolvedValue({ ok: true }),
      updateCwd: vi.fn().mockResolvedValue({ ok: true }),
      onData: vi.fn((_id: string, cb: (data: string, offset?: number) => void) => {
        hoisted.onDataHandler = cb;
        return vi.fn();
      }),
      readHistory: vi.fn(() => hoisted.historyDeferred!.promise),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { OUTPUT_COALESCE_WINDOW_MS } from '../../panels/Terminal/output-coalescer';

function Host({ termId }: { termId: string }) {
  const { containerRef, isReady } = useTerminal(termId);
  return createElement('div', { ref: containerRef, 'data-ready': String(isReady) });
}

const live = (data: string, offset?: number) => hoisted.onDataHandler!(data, offset);
// 渲染端有写入合并(src/__tests__/terminal-write/write-coalesce):空闲首块立即写,紧随其后的块
// 在一个窗口内合并写出 → 断言写入的**内容与顺序**(拼接结果),等窗口结束后再比。
const written = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, OUTPUT_COALESCE_WINDOW_MS * 3));
  });
  return hoisted.writes.join('');
};
const resolveHistory = async (v: unknown) => {
  await act(async () => {
    hoisted.historyDeferred!.resolve(v);
    await Promise.resolve();
  });
};

beforeEach(() => {
  hoisted.writes.length = 0;
  hoisted.onDataHandler = null;
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  hoisted.historyDeferred = { promise, resolve };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('terminal history replay · 渲染端衔接不重复', () => {
  it('readHistory 回复前到达、已含于快照的推送不重复写;快照后的推送按序补写', async () => {
    render(createElement(Host, { termId: 't1' }));
    act(() => {
      live('def', 3); // 已在快照内
      live('g', 6); // 快照之后
    });
    expect(hoisted.writes).toEqual([]); // 回复前先暂存
    await resolveHistory({ ok: true, data: { data: 'abcdef', truncated: false, endOffset: 6 } });
    expect(await written()).toBe('abcdefg');
  });

  it('回复之后才迟到的旧推送(偏移 < endOffset)丢弃,新推送照写', async () => {
    render(createElement(Host, { termId: 't2' }));
    await resolveHistory({ ok: true, data: { data: 'abcdef', truncated: false, endOffset: 6 } });
    act(() => {
      live('def', 3);
      live('gh', 6);
    });
    expect(await written()).toBe('abcdefgh');
  });

  it('空历史:暂存的推送照写并清 loading', async () => {
    const { container } = render(createElement(Host, { termId: 't3' }));
    act(() => live('$ ', 0));
    await resolveHistory({ ok: true, data: { data: '', truncated: false, endOffset: 0 } });
    expect(hoisted.writes).toEqual(['$ ']);
    expect(container.querySelector('div')!.getAttribute('data-ready')).toBe('true');
  });

  it('快照开头已被 ring buffer 挤掉、暂存队列更早开始 → 不写快照,照写暂存队列(不丢中段)', async () => {
    render(createElement(Host, { termId: 't5' }));
    act(() => {
      live('AAAA', 0);
      live('BBBB', 4);
      live('CC', 8);
    });
    // 快照只剩 [6,10):'BBCC';[0,6) 已被挤掉
    await resolveHistory({
      ok: true,
      data: { data: '\x1b[0mBBCC', truncated: true, endOffset: 10, startOffset: 6 },
    });
    expect(await written()).toBe('AAAABBBBCC');
  });

  it('暂存队列有缺口(overflow 截断批次)→ 不当连续超集,退回写快照', async () => {
    render(createElement(Host, { termId: 't6' }));
    act(() => {
      live('AA', 0); // [0,2)
      live('\x1b[0mZ', 2); // overflow 截断:原批次 [2,8) 只剩尾部,长度对不上下一批偏移
      live('CC', 8);
    });
    await resolveHistory({
      ok: true,
      data: { data: '\x1b[0mXXYYCC', truncated: true, endOffset: 10, startOffset: 4 },
    });
    expect(hoisted.writes).toEqual(['\x1b[0mXXYYCC']);
  });

  it('无 endOffset / 读取失败 → 暂存推送全部照写(不丢数据)', async () => {
    render(createElement(Host, { termId: 't4' }));
    act(() => live('x', 0));
    await resolveHistory({ ok: false, code: 'EIO', message: 'fail' });
    expect(hoisted.writes).toEqual(['x']);
  });
});

// @vitest-environment jsdom
// BDD: terminal-replay-dimensions / 渲染端按录制尺寸分段回放历史,再恢复当前尺寸。见同目录 README。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  /** xterm 收到的操作序列:`resize CxR` / `write <data>` / `fit`。 */
  ops: [] as string[],
  /** write 回调(模拟 xterm 异步解析):测试里逐个放行。 */
  pendingWrites: [] as Array<() => void>,
  onDataHandler: null as null | ((data: string, offset?: number) => void),
  historyDeferred: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  term: null as null | { cols: number; rows: number },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>) {
    const self = this as Record<string, unknown> & { cols: number; rows: number };
    Object.assign(this, {
      cols: 100,
      rows: 30,
      options: {},
      buffer: { normal: { length: 0 } },
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      resize: vi.fn((cols: number, rows: number) => {
        self.cols = cols;
        self.rows = rows;
        hoisted.ops.push(`resize ${cols}x${rows}`);
      }),
      write: vi.fn((d: string, cb?: () => void) => {
        hoisted.ops.push(`write ${d}`);
        if (cb) hoisted.pendingWrites.push(cb);
      }),
      dispose: vi.fn(),
    });
    hoisted.term = self;
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(() => {
      hoisted.ops.push('fit');
      if (hoisted.term) {
        hoisted.term.cols = 100;
        hoisted.term.rows = 30;
      }
    }),
    proposeDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
  })),
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({ onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })), dispose: vi.fn() })),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })) }));
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
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { replaySegments } from '../../panels/Terminal/history-replay';
import { OUTPUT_COALESCE_WINDOW_MS } from '../../panels/Terminal/output-coalescer';

function Host({ termId }: { termId: string }) {
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

const resolveHistory = async (v: unknown) => {
  await act(async () => {
    hoisted.historyDeferred!.resolve(v);
    await Promise.resolve();
  });
};
/** 放行一个 xterm 写入回调。 */
const commitWrite = async () => {
  await act(async () => {
    hoisted.pendingWrites.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  });
};
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, OUTPUT_COALESCE_WINDOW_MS * 3));
  });
};
/** 历史回放相关的操作(去掉挂载时的初始 fit)。 */
const opsAfter = (marker: string) => hoisted.ops.slice(hoisted.ops.indexOf(marker));

beforeEach(() => {
  hoisted.ops.length = 0;
  hoisted.pendingWrites.length = 0;
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

describe('replaySegments(快照 → 分段)', () => {
  const snap = (dimensions: Array<{ offset: number; cols: number; rows: number }>, data = 'abcdef', start = 0) => ({
    data,
    truncated: false,
    startOffset: start,
    endOffset: start + data.length,
    dimensions,
  });

  it('只有一段且与当前尺寸相同 / 无尺寸记录 → null(照旧整段写入)', () => {
    expect(replaySegments(snap([{ offset: 0, cols: 100, rows: 30 }]), { cols: 100, rows: 30 })).toBeNull();
    expect(replaySegments({ data: 'x', truncated: false, endOffset: 1, startOffset: 0 }, { cols: 1, rows: 1 })).toBeNull();
  });

  it('按偏移切段;截断快照的 reset 前缀归入第一段', () => {
    expect(
      replaySegments(
        {
          data: '\x1b[0mcdef',
          truncated: true,
          startOffset: 2,
          endOffset: 6,
          dimensions: [
            { offset: 2, cols: 60, rows: 20 },
            { offset: 4, cols: 80, rows: 24 },
          ],
        },
        { cols: 100, rows: 30 },
      ),
    ).toEqual([
      { data: '\x1b[0mcd', cols: 60, rows: 20 },
      { data: 'ef', cols: 80, rows: 24 },
    ]);
  });
});

describe('useTerminal:按录制尺寸回放历史', () => {
  it('尺寸不同 → resize 到录制尺寸、写入并等解析完,再下一段;最后恢复并重新 fit', async () => {
    render(createElement(Host, { termId: 'r1' }));
    await resolveHistory({
      ok: true,
      data: {
        data: 'AAAABB',
        truncated: false,
        startOffset: 0,
        endOffset: 6,
        dimensions: [
          { offset: 0, cols: 60, rows: 20 },
          { offset: 4, cols: 80, rows: 24 },
        ],
      },
    });
    // 第一段写入尚未解析完:不写第二段
    expect(opsAfter('resize 60x20')).toEqual(['resize 60x20', 'write AAAA']);
    await commitWrite();
    expect(opsAfter('resize 60x20')).toEqual(['resize 60x20', 'write AAAA', 'resize 80x24', 'write BB']);
    await commitWrite();
    expect(opsAfter('resize 60x20')).toEqual([
      'resize 60x20',
      'write AAAA',
      'resize 80x24',
      'write BB',
      'resize 100x30',
      'fit',
    ]);
  });

  it('回放期间到达的实时输出等回放完再接上,已含于快照的仍丢弃', async () => {
    render(createElement(Host, { termId: 'r2' }));
    await resolveHistory({
      ok: true,
      data: {
        data: 'AAAA',
        truncated: false,
        startOffset: 0,
        endOffset: 4,
        dimensions: [{ offset: 0, cols: 60, rows: 20 }],
      },
    });
    act(() => {
      hoisted.onDataHandler!('AA', 2); // 已在快照内
      hoisted.onDataHandler!('C', 4);
    });
    expect(hoisted.ops.some((op) => op === 'write C')).toBe(false);
    await commitWrite();
    await settle();
    const writes = hoisted.ops.filter((op) => op.startsWith('write '));
    expect(writes).toEqual(['write AAAA', 'write C']);
  });

  it('只有一段且与当前尺寸相同 → 照旧整段写入,不 resize', async () => {
    render(createElement(Host, { termId: 'r3' }));
    await resolveHistory({
      ok: true,
      data: {
        data: 'hello',
        truncated: false,
        startOffset: 0,
        endOffset: 5,
        dimensions: [{ offset: 0, cols: 100, rows: 30 }],
      },
    });
    await settle();
    expect(hoisted.ops.filter((op) => op.startsWith('resize'))).toEqual([]);
    expect(hoisted.ops).toContain('write hello');
  });
});

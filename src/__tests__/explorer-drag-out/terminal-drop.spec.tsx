// @vitest-environment jsdom
// BDD:资源管理器的文件 / 文件夹拖到终端 → 插入 shell 转义后的绝对路径(空格分隔、末尾空格、不回车)。见同目录 README「行为 3」。
import { act, cleanup, render } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { useTerminalStore } from '@/stores/terminal.store';
import { useTerminalDragDrop } from '@/panels/Terminal/useTerminalDragDrop';
import { EXPLORER_DRAG_MIME } from '@/lib/explorer-drag';

const mocks = vi.hoisted(() => ({
  getPathForFile: vi.fn<(file: File) => string>(),
  write: vi.fn<(id: string, data: string) => Promise<{ ok: boolean }>>(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { window: { getPathForFile: mocks.getPathForFile }, terminal: { write: mocks.write } },
}));
vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: { count?: number }) => (params?.count === undefined ? key : `${key}:${params.count}`),
}));

if (typeof globalThis.DragEvent === 'undefined') {
  class TestDragEvent extends MouseEvent {
    readonly dataTransfer: DataTransfer | null;
    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  Object.defineProperty(globalThis, 'DragEvent', { configurable: true, value: TestDragEvent });
}

const RECT = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

function Host({ focus }: { focus: () => void }) {
  const api = useMemo(() => ({ onDidLocationChange: () => ({ dispose: () => {} }) }), []);
  const { ref } = useTerminalDragDrop({ sessionId: 'term-1', focus, api: api as never });
  return <div ref={ref} data-testid="term" />;
}

function explorerDataTransfer(entries: { path: string; isDirectory: boolean }[]) {
  const data = new Map([[EXPLORER_DRAG_MIME, JSON.stringify(entries)], ['text/plain', entries.map((e) => e.path).join('\n')]]);
  return { types: [...data.keys()], files: [], dropEffect: 'none', getData: (f: string) => data.get(f) ?? '' } as unknown as DataTransfer;
}

async function dropOn(el: Element, dataTransfer: DataTransfer, point = { clientX: 50, clientY: 50 }) {
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, ...point, dataTransfer });
  const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, ...point, dataTransfer });
  await act(async () => {
    el.dispatchEvent(over);
    el.dispatchEvent(dropped);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { over, dropped };
}

beforeEach(() => {
  mocks.getPathForFile.mockReset();
  mocks.write.mockReset().mockResolvedValue({ ok: true });
  useTerminalStore.setState({
    sessions: [
      { id: 'term-1', title: 'T', cwd: '/w', originHint: 'user', createdAt: 1, exitCode: null, ownerWindowId: 1, shellFamily: 'posix' } as never,
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useTerminalStore.setState({ sessions: [] });
});

function renderTerm() {
  const focus = vi.fn();
  const view = render(
    <NotificationsProvider>
      <Host focus={focus} />
    </NotificationsProvider>,
  );
  const el = view.getByTestId('term');
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(RECT);
  return { el, focus };
}

describe('树拖到终端', () => {
  it('多选(含文件夹)→ 插入 POSIX 转义后的路径,空格分隔 + 末尾空格,不回车;终端获焦;不经 getPathForFile', async () => {
    const { el, focus } = renderTerm();
    const { over, dropped } = await dropOn(
      el,
      explorerDataTransfer([
        { path: "/w/a b.ts", isDirectory: false },
        { path: "/w/o'reilly", isDirectory: true },
      ]),
    );
    expect(over.defaultPrevented).toBe(true);
    expect(dropped.defaultPrevented).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith('term-1', "'/w/a b.ts' '/w/o'\\''reilly' ");
    expect(mocks.write.mock.calls[0]![1]).not.toMatch(/[\r\n]/);
    expect(mocks.getPathForFile).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
  });

  it('落点不在终端内 → 不接管、不写入', async () => {
    const { el } = renderTerm();
    const { over } = await dropOn(el, explorerDataTransfer([{ path: '/w/a.ts', isDirectory: false }]), { clientX: 500, clientY: 500 });
    expect(over.defaultPrevented).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('含控制字符的路径被拒绝,其余照常插入', async () => {
    const { el } = renderTerm();
    await dropOn(
      el,
      explorerDataTransfer([
        { path: '/w/evil\nrm', isDirectory: false },
        { path: '/w/ok.ts', isDirectory: false },
      ]),
    );
    expect(mocks.write).toHaveBeenCalledWith('term-1', '/w/ok.ts ');
  });
});

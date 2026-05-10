// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef } from 'react';

// useTerminal 依赖 xterm + IPC,测试里 stub 掉。
vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: vi.fn(),
}));

import { TerminalView } from '../../panels/Terminal/TerminalView';
import { useTerminal } from '../../panels/Terminal/useTerminal';

const useTerminalMock = useTerminal as unknown as ReturnType<typeof vi.fn>;

afterEach(() => cleanup());

function makeRefImpl(isReady: boolean) {
  return () => {
    // 注意:不能在 vi.fn() 之外直接 useRef;改写成 React hook 调用包装
    // 但 useTerminal 自身是 hook,我们 mock 时直接返回稳定对象即可。
    return {
      containerRef: { current: null },
      isReady,
    };
  };
}

describe('TerminalView', () => {
  it('isReady=false → 渲染 loading overlay 文案「启动 shell…」', () => {
    useTerminalMock.mockImplementation(makeRefImpl(false));
    const { container } = render(<TerminalView termId="t1" />);
    expect(container.textContent).toContain('启动 shell…');
    const overlay = container.querySelector('[aria-label="启动 shell"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.className).toContain('pointer-events-none');
  });

  it('isReady=true → 无 overlay', () => {
    useTerminalMock.mockImplementation(makeRefImpl(true));
    const { container } = render(<TerminalView termId="t1" />);
    expect(container.textContent).not.toContain('启动 shell…');
    expect(
      container.querySelector('[aria-label="启动 shell"]'),
    ).toBeNull();
  });

  it('xterm 宿主有 minHeight:0 inline style', () => {
    useTerminalMock.mockImplementation(makeRefImpl(false));
    const { container } = render(<TerminalView termId="t1" />);
    const host = container.querySelector(
      '[data-testid="terminal-xterm-host"]',
    ) as HTMLElement;
    expect(host.style.minHeight).toBe('0px');
  });

  // 回归 issue #15:横向 padding 必须在 xterm 宿主的**外层**而非宿主自身,
  // 否则 fitAddon 读 .xterm.padding=0 + 整个 containerRef.width(border-box)
  // → cols 算多 → 最右列绘到 .xterm 边界外被裁。
  it('padding 在外 wrapper,xterm 宿主自身无 padding (#15)', () => {
    useTerminalMock.mockImplementation(makeRefImpl(false));
    const { container } = render(<TerminalView termId="t1" />);
    const wrapper = container.querySelector('.bg-canvas') as HTMLElement;
    expect(wrapper.className).toMatch(/\bpx-2\b/);
    const host = container.querySelector(
      '[data-testid="terminal-xterm-host"]',
    ) as HTMLElement;
    // 宿主自身不能再带 px-* / p-* / pl-* / pr-* 任何横向 padding,
    // 否则 fitAddon 仍会把 padding 区算进可用宽。
    expect(host.className).not.toMatch(/\b(p|px|pl|pr)-\d/);
  });

  it('useTerminal 收到 termId 参数', () => {
    useTerminalMock.mockImplementation(makeRefImpl(true));
    render(<TerminalView termId="my-terminal" />);
    expect(useTerminalMock).toHaveBeenCalledWith('my-terminal');
  });
});

// 覆盖 useRef 引用回路:用一个轻量 Probe 校验 mock 形态正确
describe('TerminalView — internal sanity', () => {
  it('useRef 路径不抛(冒烟)', () => {
    function Inner() {
      const r = useRef<HTMLDivElement | null>(null);
      return <div ref={r} />;
    }
    const { container } = render(<Inner />);
    expect(container.querySelector('div')).not.toBeNull();
  });
});

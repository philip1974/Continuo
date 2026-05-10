// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { TerminalTabs } from '../../panels/Terminal/TerminalTabs';
import {
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';

function s(over: Partial<TerminalSession>): TerminalSession {
  return {
    id: 't1',
    title: 'shell',
    cwd: '/',
    originHint: 'user',
    createdAt: 0,
    exitCode: null,
    ...over,
  };
}

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [],
    activeId: null,
    customTitles: new Map(),
  });
});

afterEach(() => cleanup());

describe('TerminalTabs', () => {
  it('单 session, showTabList=true → 渲染 tab + + 按钮', () => {
    useTerminalStore.setState({
      sessions: [s({ id: 't1', title: 'zsh' })],
      activeId: 't1',
    });
    const { container } = render(
      <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
    );
    expect(container.textContent).toContain('zsh');
    expect(
      container.querySelector('button[aria-label="新建终端"]'),
    ).not.toBeNull();
  });

  it('showTabList=false → 不渲染 tabs,但 + 仍在', () => {
    useTerminalStore.setState({
      sessions: [s({ id: 't1', title: 'zsh' })],
      activeId: 't1',
    });
    const { container } = render(
      <TerminalTabs
        onNewSession={vi.fn()}
        onCloseSession={vi.fn()}
        showTabList={false}
      />,
    );
    expect(container.textContent).not.toContain('zsh');
    expect(
      container.querySelector('button[aria-label="新建终端"]'),
    ).not.toBeNull();
  });

  it('agent 来源 → 渲染 ● 标记', () => {
    useTerminalStore.setState({
      sessions: [
        s({
          id: 't1',
          title: 'codex',
          originHint: 'agent',
          agentLabel: 'codex-cli',
        }),
      ],
      activeId: 't1',
    });
    const { container } = render(
      <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
    );
    // ● 字符出现
    expect(container.textContent).toContain('●');
  });

  it('exitCode 非 null → 文案含「(已退出)」', () => {
    useTerminalStore.setState({
      sessions: [s({ id: 't1', title: 'zsh', exitCode: 0 })],
      activeId: 't1',
    });
    const { container } = render(
      <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
    );
    expect(container.textContent).toContain('(已退出)');
  });

  it('点「+」 → onNewSession', () => {
    const onNewSession = vi.fn();
    const { container } = render(
      <TerminalTabs onNewSession={onNewSession} onCloseSession={vi.fn()} />,
    );
    fireEvent.click(container.querySelector('button[aria-label="新建终端"]')!);
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('点 tab → setActive(id)', () => {
    useTerminalStore.setState({
      sessions: [
        s({ id: 't1', title: 'a' }),
        s({ id: 't2', title: 'b' }),
      ],
      activeId: 't1',
    });
    const { container } = render(
      <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
    );
    const bTab = Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"], button'),
    ).find((el) => el.textContent?.includes('b'));
    expect(bTab).toBeDefined();
    fireEvent.click(bTab!);
    expect(useTerminalStore.getState().activeId).toBe('t2');
  });

  // 回归 issue #19:双击 → input → 回车保存到 customTitles;Esc 取消;
  // customTitles 优先于 session.title 显示;空字符串清除 override。
  describe('rename(#19)', () => {
    it('双击 tab → 出 input,值 = 当前显示 title', () => {
      useTerminalStore.setState({
        sessions: [s({ id: 't1', title: 'zsh' })],
        activeId: 't1',
      });
      const { container } = render(
        <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
      );
      const tabBtn = container.querySelector(
        '.wm-tab-nav-item__select',
      ) as HTMLElement;
      fireEvent.doubleClick(tabBtn);
      const input = container.querySelector(
        'input[aria-label^="重命名终端"]',
      ) as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('zsh');
    });

    it('改 input + 回车 → renameSession 写到 customTitles', () => {
      useTerminalStore.setState({
        sessions: [s({ id: 't1', title: 'zsh' })],
        activeId: 't1',
      });
      const { container } = render(
        <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
      );
      fireEvent.doubleClick(
        container.querySelector('.wm-tab-nav-item__select')!,
      );
      const input = container.querySelector(
        'input[aria-label^="重命名终端"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '调试 prompt' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(useTerminalStore.getState().customTitles.get('t1')).toBe(
        '调试 prompt',
      );
    });

    it('改 input + Esc → 不写入 store,退出编辑态', () => {
      useTerminalStore.setState({
        sessions: [s({ id: 't1', title: 'zsh' })],
        activeId: 't1',
      });
      const { container } = render(
        <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
      );
      fireEvent.doubleClick(
        container.querySelector('.wm-tab-nav-item__select')!,
      );
      const input = container.querySelector(
        'input[aria-label^="重命名终端"]',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '不要保存' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(useTerminalStore.getState().customTitles.has('t1')).toBe(false);
      expect(
        container.querySelector('input[aria-label^="重命名终端"]'),
      ).toBeNull();
    });

    it('customTitles 优先于 session.title 显示', () => {
      useTerminalStore.setState({
        sessions: [s({ id: 't1', title: 'zsh' })],
        activeId: 't1',
        customTitles: new Map([['t1', 'my-shell']]),
      });
      const { container } = render(
        <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
      );
      expect(container.textContent).toContain('my-shell');
      expect(container.textContent).not.toContain('zsh');
    });

    it('renaming 状态下点击 tab 不切 active(避免 input click 冒泡误切)', () => {
      useTerminalStore.setState({
        sessions: [
          s({ id: 't1', title: 'a' }),
          s({ id: 't2', title: 'b' }),
        ],
        activeId: 't2',
      });
      const { container } = render(
        <TerminalTabs onNewSession={vi.fn()} onCloseSession={vi.fn()} />,
      );
      const t1Btn = container.querySelectorAll(
        '.wm-tab-nav-item__select',
      )[0] as HTMLElement;
      fireEvent.doubleClick(t1Btn);
      // 进入 t1 rename 态后,点击 t1 input 不能改 activeId
      const input = container.querySelector(
        'input[aria-label^="重命名终端"]',
      ) as HTMLInputElement;
      fireEvent.click(input);
      expect(useTerminalStore.getState().activeId).toBe('t2');
    });
  });
});

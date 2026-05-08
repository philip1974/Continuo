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
  useTerminalStore.setState({ sessions: [], activeId: null });
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
});

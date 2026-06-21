// @vitest-environment jsdom
// 打磨 R42(codex 一致性/i18n):TerminalPanelView 两个异常占位(缺 sessionId /
// session 丢失)原先硬编码英文,补 panels.terminal.missing_session_id /
// session_not_available 到 en/zh/ko + t() 渲染。zh/ko 下降级提示不再混英文。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TerminalPanelView } from '../../panels/Terminal/TerminalPanelView';
import { useTerminalStore } from '../../stores/terminal.store';
import { setLocale } from '../../i18n';

function makeProps(sessionId: string): Parameters<typeof TerminalPanelView>[0] {
  return {
    api: { id: 'p1', title: '', close: vi.fn(), setTitle: vi.fn() },
    params: { sessionId },
  } as unknown as Parameters<typeof TerminalPanelView>[0];
}

beforeEach(() => {
  useTerminalStore.setState({ sessions: [], activeId: null, customTitles: new Map() });
});
afterEach(() => {
  setLocale('en');
  cleanup();
});

describe('打磨 R42 — 终端面板异常态本地化', () => {
  it('zh:缺 sessionId → 显中文占位,不混英文', () => {
    setLocale('zh');
    const { container } = render(<TerminalPanelView {...makeProps('')} />);
    expect(container.textContent).toContain('缺少 sessionId');
    expect(container.textContent).not.toContain('auto-closing');
  });

  it('zh:session 不存在 → 「会话不可用」', () => {
    setLocale('zh');
    const { container } = render(<TerminalPanelView {...makeProps('missing-id')} />);
    expect(container.textContent).toContain('会话不可用');
    expect(container.textContent).not.toContain('session not available');
  });

  it('en:缺 sessionId → 英文占位', () => {
    setLocale('en');
    const { container } = render(<TerminalPanelView {...makeProps('')} />);
    expect(container.textContent).toContain('auto-closing');
  });
});

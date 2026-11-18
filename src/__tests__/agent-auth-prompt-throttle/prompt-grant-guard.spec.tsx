// @vitest-environment jsdom
// 安全:授权弹窗出现后的一小段时间内,「允许」类按钮的鼠标 / 键盘激活无效(用户正在打字 / 点击时弹窗抢焦点,
// 按键不能落成授予);「拒绝」与 Esc 立即可用。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { AgentAuthPrompt, AGENT_AUTH_GRANT_ARM_DELAY_MS } from '../../shell/AgentAuthPrompt';
import {
  _resetAgentAuthForTest,
  useAgentAuthStore,
  type EnsureOutcome,
} from '../../stores/agent-auth.store';

vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

const store = () => useAgentAuthStore.getState();

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

/** 弹出一个授权弹窗,返回其结算结果的读取器。 */
function prompt(
  info: { method: string; external?: boolean } = { method: 'terminal.send_text' },
): () => Promise<EnsureOutcome | null> {
  let outcome: EnsureOutcome | null = null;
  act(() => {
    void store()
      .ensure(info)
      .then((o) => {
        outcome = o;
      });
  });
  return async () => {
    await act(async () => {
      await Promise.resolve();
    });
    return outcome;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetLmApiForTest();
  _resetAgentAuthForTest();
  Object.defineProperty(window, 'api', {
    value: {
      agentAuth: {
        onRequest: vi.fn(() => () => {}),
        onRevoked: vi.fn(() => () => {}),
        respond: vi.fn(async () => ({ ok: true })),
      },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  render(<AgentAuthPrompt />);
});

afterEach(() => {
  cleanup();
  delete (window as { api?: unknown }).api;
  _resetAgentAuthForTest();
  vi.useRealTimers();
});

describe('AgentAuthPrompt:授予方向的防误触延迟', () => {
  it.each(['仅本次', '本次启动期间允许'])(
    `弹出后 ${AGENT_AUTH_GRANT_ARM_DELAY_MS}ms 内点「%s」无效,弹窗保持;之后有效`,
    async (label) => {
      const outcome = prompt();
      fireEvent.click(button(label));
      act(() => {
        vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS - 1);
      });
      fireEvent.click(button(label));
      expect(await outcome()).toBeNull();
      expect(store().pending).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      fireEvent.click(button(label));
      expect(await outcome()).toBe(label === '仅本次' ? 'once' : 'session');
    },
  );

  it('「拒绝」弹出后立即可用', async () => {
    const outcome = prompt();
    fireEvent.click(button('拒绝'));
    expect(await outcome()).toBe('denied');
  });

  it('Esc 弹出后立即可用(按拒绝收口)', async () => {
    const outcome = prompt();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await outcome()).toBe('denied');
  });

  it('初始焦点仍在「拒绝」', () => {
    prompt();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(document.activeElement).toBe(button('拒绝'));
  });

  it('上一个弹窗落定后紧接着显示排队的下一个 → 延迟重新计时(对旧弹窗的连点不落到新请求上)', async () => {
    const ext = prompt({ method: 'terminal.send_text', external: true });
    const inWindow = prompt({ method: 'terminal.create_session' });
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    fireEvent.click(button('仅本次'));
    expect(await ext()).toBe('once');
    // 新弹窗(窗口内请求)刚显示:同一位置的「仅本次」此刻无效。
    fireEvent.click(button('仅本次'));
    expect(await inWindow()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    fireEvent.click(button('仅本次'));
    expect(await inWindow()).toBe('once');
  });
});

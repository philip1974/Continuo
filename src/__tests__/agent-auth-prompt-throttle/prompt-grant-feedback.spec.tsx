// @vitest-environment jsdom
// a11y:被防误触守卫拒掉的授予激活此前没有任何反馈 —— 辅助技术合成的点击(detail=0、没有 keydown、DOM 焦点可能
// 不在按钮上)可能一直无效,用户不知道为什么。被拒时弹窗里的 status 区域给出提示(可见 + 读屏播报);规则不放宽。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { AgentAuthPrompt } from '../../shell/AgentAuthPrompt';
import {
  PROMPT_GRANT_ARM_DELAY_MS as DELAY,
  PROMPT_GRANT_HINT_MS,
} from '../../lib/use-prompt-grant-guard';
import {
  _resetAgentAuthForTest,
  useAgentAuthStore,
  type EnsureOutcome,
} from '../../stores/agent-auth.store';
import { advanceInAct as advance } from '../_helpers/react-timers';

vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

const store = () => useAgentAuthStore.getState();
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}
const status = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('.wm-modal-content [role="status"]');
  if (!el) throw new Error('status region not found');
  return el;
};

function prompt(method = 'terminal.send_text', external = false): () => Promise<EnsureOutcome | null> {
  let outcome: EnsureOutcome | null = null;
  act(() => {
    void store()
      .ensure({ requestId: crypto.randomUUID(), method, ...(external ? { external } : {}) })
      .then((o) => {
        outcome = o;
      });
  });
  advance(30);
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
        onCancelled: vi.fn(() => () => {}),
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

describe('AgentAuthPrompt:被守卫拒掉的授予激活有可感知反馈', () => {
  it('弹窗里始终有一个空的 status 区域(读屏只播报之后出现的内容)', () => {
    prompt();
    expect(status().textContent).toBe('');
  });

  it('出现延迟内点「仅本次」→ 不授予,status 区域出现提示;一段时间后提示消失', async () => {
    const outcome = prompt();
    fireEvent.click(button('仅本次'), { detail: 1 });
    expect(await outcome()).toBeNull();
    expect(status().textContent).not.toBe('');
    advance(PROMPT_GRANT_HINT_MS);
    expect(status().textContent).toBe('');
  });

  it('辅助技术合成的点击(detail=0、无 keydown、焦点不在按钮上)→ 仍不授予,但有提示', async () => {
    const outcome = prompt();
    advance(DELAY * 4);
    expect(document.activeElement).toBe(button('拒绝'));
    fireEvent.click(button('仅本次'), { detail: 0 });
    expect(await outcome()).toBeNull();
    expect(status().textContent).not.toBe('');
  });

  it('有效的授予不出提示;「拒绝」不出提示', async () => {
    const outcome = prompt();
    advance(DELAY);
    fireEvent.click(button('仅本次'), { detail: 1 });
    expect(await outcome()).toBe('once');

    prompt();
    fireEvent.click(button('本次启动期间允许'), { detail: 1 }); // 被拒 → 提示
    expect(status().textContent).not.toBe('');
  });

  it('排队切换到下一个请求时提示清空', async () => {
    const first = prompt('terminal.send_text', true);
    prompt('terminal.create_session');
    fireEvent.click(button('仅本次'), { detail: 1 });
    expect(status().textContent).not.toBe('');
    fireEvent.click(button('拒绝'), { detail: 1 });
    expect(await first()).toBe('denied');
    expect(store().pending).not.toBeNull();
    expect(status().textContent).toBe('');
  });
});

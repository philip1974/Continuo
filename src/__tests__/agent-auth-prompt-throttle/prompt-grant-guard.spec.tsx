// @vitest-environment jsdom
// 安全:授权弹窗出现后的一小段时间内,「允许」类按钮与「拒绝」/ Esc 的激活都无效(用户正在打字 / 点击时弹窗抢焦点,
// 按键不能落成授予,也不能落成会进冷却的拒绝);初始焦点在对话框容器上。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { AgentAuthPrompt } from '../../shell/AgentAuthPrompt';
import { PROMPT_GRANT_ARM_DELAY_MS as AGENT_AUTH_GRANT_ARM_DELAY_MS } from '../../lib/use-prompt-grant-guard';
import {
  _resetAgentAuthForTest,
  useAgentAuthStore,
  type EnsureOutcome,
} from '../../stores/agent-auth.store';
import { advanceInAct as advance } from '../_helpers/react-timers';

// 指针点击(浏览器里鼠标 click 的 detail ≥ 1;fireEvent.click 默认 detail=0,会被当作键盘激活,授予按钮对键盘
// 激活另有「停顿后的有意按键」要求,见 keyboard-grant-guard 规范)。
const pointerClick = (el: Element): boolean => fireEvent.click(el, { detail: 1 });

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
      .ensure({ requestId: crypto.randomUUID(), ...info })
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

describe('AgentAuthPrompt:授予方向的防误触延迟', () => {
  it.each(['仅本次', '本次启动期间允许'])(
    `弹出后 ${AGENT_AUTH_GRANT_ARM_DELAY_MS}ms 内点「%s」无效,弹窗保持;之后有效`,
    async (label) => {
      const outcome = prompt();
      act(() => {
        vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS - 1);
      });
      pointerClick(button(label));
      expect(await outcome()).toBeNull();
      expect(store().pending).not.toBeNull();
    },
  );

  it.each(['仅本次', '本次启动期间允许'])(
    `弹出 ${AGENT_AUTH_GRANT_ARM_DELAY_MS}ms 后点「%s」有效`,
    async (label) => {
      const outcome = prompt();
      act(() => {
        vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
      });
      pointerClick(button(label));
      expect(await outcome()).toBe(label === '仅本次' ? 'once' : 'session');
    },
  );

  it('「拒绝」同样有出现延迟:延迟内点击无效(不应答、不进冷却),之后有效', async () => {
    const outcome = prompt();
    pointerClick(button('拒绝'));
    expect(await outcome()).toBeNull();
    expect(store().pending).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    pointerClick(button('拒绝'));
    expect(await outcome()).toBe('denied');
  });

  it('Esc:延迟内无效;停顿后的 Esc 按拒绝收口;输入流里紧跟别的按键的 Esc 不算', async () => {
    const outcome = prompt();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await outcome()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    // vim 里 `ihello<Esc>`:Esc 紧跟在打字之后
    fireEvent.keyDown(document, { key: 'o' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await outcome()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await outcome()).toBe('denied');
  });

  it('初始焦点在对话框容器上,不在任何按钮上(打字中的空格 / 回车不点下按钮)', async () => {
    const outcome = prompt();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document.activeElement!, { key: ' ' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(await outcome()).toBeNull();
  });

  it('上一个弹窗落定后紧接着显示排队的下一个 → 延迟重新计时(对旧弹窗的连点不落到新请求上)', async () => {
    const ext = prompt({ method: 'terminal.send_text', external: true });
    const inWindow = prompt({ method: 'terminal.create_session' });
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    pointerClick(button('仅本次'));
    expect(await ext()).toBe('once');
    // 新弹窗(窗口内请求)刚显示:同一位置的「仅本次」此刻无效。
    pointerClick(button('仅本次'));
    expect(await inWindow()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(AGENT_AUTH_GRANT_ARM_DELAY_MS);
    });
    pointerClick(button('仅本次'));
    expect(await inWindow()).toBe('once');
  });
});

// 出现延迟只按「出现时刻」计:一次双击的第一击落在延迟内被拒,第二击跨过 500ms 就成了授予。
describe('AgentAuthPrompt:双击 / 过早的点击不能跨过出现延迟', () => {
  const D = AGENT_AUTH_GRANT_ARM_DELAY_MS;

  it('审计复现:出现后 +350ms 第一击(无效)、+560ms 第二击(detail=2)落在「本次启动期间允许」→ 不授予', async () => {
    const outcome = prompt();
    advance(350);
    fireEvent.click(button('本次启动期间允许'), { detail: 1 });
    expect(await outcome()).toBeNull();
    advance(210);
    fireEvent.click(button('本次启动期间允许'), { detail: 2 });
    expect(await outcome()).toBeNull();
    expect(store().pending).not.toBeNull();
  });

  it('被出现延迟拒掉的点击把计时起点推到该次点击:之后的单击也要再等满延迟', async () => {
    const outcome = prompt();
    advance(D - 1);
    pointerClick(button('仅本次')); // 无效,重新计时
    advance(D - 1); // 距出现已远超延迟,但距上次过早的点击不足
    pointerClick(button('仅本次'));
    expect(await outcome()).toBeNull();
    advance(D);
    pointerClick(button('仅本次'));
    expect(await outcome()).toBe('once');
  });

  it('延迟过后:双击 / 三击的后几击(detail ≥ 2)不算授予,单击(detail=1)才算', async () => {
    const outcome = prompt();
    advance(D);
    fireEvent.click(button('本次启动期间允许'), { detail: 2 });
    fireEvent.click(button('本次启动期间允许'), { detail: 3 });
    expect(await outcome()).toBeNull();
    fireEvent.click(button('本次启动期间允许'), { detail: 1 });
    expect(await outcome()).toBe('session');
  });

  it('「拒绝」同样:延迟内无效,双击的第二击不算', async () => {
    const outcome = prompt();
    fireEvent.click(button('拒绝'), { detail: 1 });
    advance(D + 10);
    fireEvent.click(button('拒绝'), { detail: 2 });
    expect(await outcome()).toBeNull();
    advance(D);
    fireEvent.click(button('拒绝'), { detail: 1 });
    expect(await outcome()).toBe('denied');
  });
});

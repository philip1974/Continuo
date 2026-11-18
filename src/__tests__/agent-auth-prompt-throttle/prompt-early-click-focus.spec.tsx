// @vitest-environment jsdom
// 安全:被守卫拒掉的指针点击不能留下「可用键盘授予」的焦点。Chromium 在 mousedown 时把焦点移到被按的按钮上;
// 过早的单击(出现后 +200ms)被拒,但焦点已在「本次启动期间允许」上,停顿 700ms 后的 Enter 满足全部键盘条件
// (聚焦 ≥ 500ms、没打过字、停顿后的单次按键、焦点不是 Tab 带来的)→ 落成整域授予。两层:
// ①指针点击会被拒的时刻,弹窗里的 mousedown / pointerdown 被 preventDefault(焦点不移入);
// ②点击被拒时焦点若已在该控件上 → 这次聚焦不可键盘授予,焦点移回「拒绝」。
// 真实 Chromium 的 mousedown 聚焦见 tests/e2e/permission-prompt-keyboard-grant-guard.spec.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { AgentAuthPrompt } from '../../shell/AgentAuthPrompt';
import { PROMPT_GRANT_ARM_DELAY_MS as DELAY } from '../../lib/use-prompt-grant-guard';
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
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const focused = (): HTMLElement => document.activeElement as HTMLElement;

function press(key: string): void {
  const el = focused();
  const notPrevented = fireEvent.keyDown(el, { key });
  if (notPrevented && (key === 'Enter' || key === ' ') && el.tagName === 'BUTTON') {
    fireEvent.click(el, { detail: 0 });
  }
  fireEvent.keyUp(el, { key });
}
/**
 * 一次鼠标点击(连击的第 detail 击)。jsdom 不做 mousedown 的默认动作,这里补上聚焦:
 * - 'browser':按浏览器规则,pointerdown / mousedown 没被 preventDefault 才聚焦;
 * - 'always':不管是否被取消都聚焦(审计者的模拟:焦点经别的途径已在按钮上,单测第②层)。
 */
function mouseClick(el: HTMLElement, detail = 1, focus: 'browser' | 'always' = 'browser'): void {
  const down = fireEvent.pointerDown(el) && fireEvent.mouseDown(el, { detail });
  if (down || focus === 'always') act(() => el.focus());
  fireEvent.mouseUp(el, { detail });
  fireEvent.click(el, { detail });
}

/** 弹出授权弹窗(只等初始焦点落到「拒绝」,不等出现延迟),返回其结算结果的读取器。 */
function prompt(): () => Promise<EnsureOutcome | null> {
  let outcome: EnsureOutcome | null = null;
  act(() => {
    void store()
      .ensure({ method: 'terminal.send_text' })
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

describe.each(['browser', 'always'] as const)(
  'AgentAuthPrompt:过早的点击被拒后,停顿后的键盘按键不落成授予(mousedown 聚焦:%s)',
  (focus) => {
    it('G1:+200ms 单击「本次启动期间允许」→ 被拒;+700ms Enter → 未授予,焦点在「拒绝」', async () => {
      const outcome = prompt();
      advance(170);
      mouseClick(button('本次启动期间允许'), 1, focus);
      expect(await outcome()).toBeNull();
      expect(focused()).toBe(button('拒绝'));
      advance(700);
      press('Enter');
      expect(await outcome()).toBe('denied');
    });

    it('G1b:双击落在「仅本次」(第一击过早、第二击 detail=2)→ +600ms Enter → 未授予', async () => {
      const outcome = prompt();
      advance(270);
      mouseClick(button('仅本次'), 1, focus);
      advance(150);
      mouseClick(button('仅本次'), 2, focus);
      expect(await outcome()).toBeNull();
      expect(focused()).toBe(button('拒绝'));
      advance(600);
      press('Enter');
      expect(await outcome()).toBe('denied');
    });
  },
);

describe('AgentAuthPrompt:指针按下的默认动作(聚焦)只在点击会被拒时取消', () => {
  it('出现时间窗内:授予按钮上的 mousedown 与 pointerdown 都被 preventDefault', () => {
    prompt();
    advance(170);
    expect(fireEvent.pointerDown(button('本次启动期间允许'))).toBe(false);
    expect(fireEvent.mouseDown(button('本次启动期间允许'), { detail: 1 })).toBe(false);
  });

  it('被拒的点击把时间窗推后:推后的窗口内按下仍被取消', () => {
    prompt();
    advance(DELAY - 130);
    mouseClick(button('仅本次'));
    advance(DELAY - 100); // 距出现已超过一个时间窗,但距被拒的点击不足
    expect(fireEvent.mouseDown(button('仅本次'), { detail: 1 })).toBe(false);
  });

  it('时间窗过后:单击的按下不取消(焦点照常移入),点击照常授予', async () => {
    const outcome = prompt();
    advance(DELAY + 100);
    expect(fireEvent.pointerDown(button('仅本次'))).toBe(true);
    expect(fireEvent.mouseDown(button('仅本次'), { detail: 1 })).toBe(true);
    mouseClick(button('仅本次'));
    expect(await outcome()).toBe('once');
  });

  it('时间窗过后:多击的后几击(detail ≥ 2)的按下被取消', () => {
    prompt();
    advance(DELAY + 100);
    expect(fireEvent.mouseDown(button('仅本次'), { detail: 2 })).toBe(false);
  });

  it('弹窗之外的按下不受影响', () => {
    prompt();
    advance(70);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    expect(fireEvent.mouseDown(outside, { detail: 1 })).toBe(true);
    outside.remove();
  });
});

describe('AgentAuthPrompt:正常路径不回归', () => {
  it('过早的点击被拒 → 等满时间窗 → 再单击 → 授予', async () => {
    const outcome = prompt();
    advance(170);
    mouseClick(button('本次启动期间允许'));
    expect(await outcome()).toBeNull();
    advance(DELAY);
    mouseClick(button('本次启动期间允许'));
    expect(await outcome()).toBe('session');
  });

  it('过早的点击被拒后,键盘仍可授予:停顿 → Tab 到按钮 → 停顿 → Enter', async () => {
    const outcome = prompt();
    advance(170);
    mouseClick(button('仅本次'), 1, 'always');
    expect(focused()).toBe(button('拒绝'));
    advance(DELAY + 100);
    if (fireEvent.keyDown(focused(), { key: 'Tab' })) button('仅本次').focus();
    advance(DELAY + 100);
    press('Enter');
    expect(await outcome()).toBe('once');
  });

  it('被拒的键盘激活不移动焦点(Tab 后立刻 Enter 被拒,停顿后再 Enter 授予)', async () => {
    const outcome = prompt();
    advance(DELAY + 100);
    if (fireEvent.keyDown(focused(), { key: 'Tab' })) button('仅本次').focus();
    press('Enter');
    expect(await outcome()).toBeNull();
    expect(focused()).toBe(button('仅本次'));
    advance(DELAY + 100);
    press('Enter');
    expect(await outcome()).toBe('once');
  });

  it('过早点「拒绝」照常立即拒绝', async () => {
    const outcome = prompt();
    advance(70);
    mouseClick(button('拒绝'));
    expect(await outcome()).toBe('denied');
  });
});

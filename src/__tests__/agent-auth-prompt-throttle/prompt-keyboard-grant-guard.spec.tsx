// @vitest-environment jsdom
// 安全:授权弹窗抢走焦点后,用户还在继续原来的输入流(Shift+Tab 切模式后打字再回车、Tab 补全后回车)。出现后的
// 500ms 延迟挡不住这种「晚到」的 Space / Enter,所以授予按钮的**键盘**激活另有要求:按钮已持续聚焦一段时间、
// 聚焦期间没打过字、且这一下按键之前有停顿;Shift+Tab 不能从「拒绝」回绕到授予按钮。鼠标点击只受出现延迟约束,
// 「拒绝」与 Esc 不受限制。行为见同目录 README。
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

/**
 * 在当前焦点元素上按一个键。jsdom 不做浏览器的默认动作,这里补上按钮的键盘激活:Enter / Space 落在按钮上 =
 * 一次 detail=0 的 click(keydown 被 preventDefault 则没有)。
 */
function press(key: string, init: { shiftKey?: boolean; repeat?: boolean } = {}): void {
  const el = focused();
  const notPrevented = fireEvent.keyDown(el, { key, ...init });
  if (notPrevented && (key === 'Enter' || key === ' ') && el.tagName === 'BUTTON') {
    fireEvent.click(el, { detail: 0 });
  }
  fireEvent.keyUp(el, { key, ...init });
}
function type(text: string): void {
  for (const ch of text) press(ch);
}
/** Tab 到指定元素(jsdom 不移动焦点,手动补上;keydown 被拦下则焦点不动)。 */
function tabTo(el: HTMLElement): void {
  if (fireEvent.keyDown(focused(), { key: 'Tab' })) el.focus();
}

/** 弹出一个授权弹窗并等过出现延迟(初始焦点已落在「拒绝」),返回其结算结果的读取器。 */
function prompt(): () => Promise<EnsureOutcome | null> {
  let outcome: EnsureOutcome | null = null;
  act(() => {
    void store()
      .ensure({ method: 'terminal.send_text' })
      .then((o) => {
        outcome = o;
      });
  });
  advance(DELAY + 100);
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

describe('AgentAuthPrompt:授予按钮的键盘激活须是停顿后的有意按键', () => {
  it('Shift+Tab 不能从「拒绝」回绕到授予按钮:焦点留在「拒绝」', async () => {
    const outcome = prompt();
    expect(focused()).toBe(button('拒绝'));
    press('Tab', { shiftKey: true });
    expect(focused()).toBe(button('拒绝'));
    expect(await outcome()).toBeNull();
  });

  it.each(['Enter', ' '])('焦点刚到授予按钮就按 %j → 不授予', async (key) => {
    const outcome = prompt();
    button('本次启动期间允许').focus();
    press(key);
    advance(DELAY - 1);
    press(key);
    expect(await outcome()).toBeNull();
    expect(store().pending).not.toBeNull();
  });

  it('Tab → Enter 的快速序列(补全后回车)落在「仅本次」上 → 不授予', async () => {
    const outcome = prompt();
    tabTo(button('仅本次'));
    press('Enter');
    expect(await outcome()).toBeNull();
  });

  it('Tab Tab Enter 的快速序列落在「本次启动期间允许」上 → 不授予', async () => {
    const outcome = prompt();
    tabTo(button('仅本次'));
    tabTo(button('本次启动期间允许'));
    press('Enter');
    expect(await outcome()).toBeNull();
  });

  it('焦点在授予按钮上时打字,紧接着的 Space / Enter → 不授予', async () => {
    const outcome = prompt();
    button('本次启动期间允许').focus();
    advance(DELAY);
    type('fix');
    press(' ');
    type('the');
    press('Enter');
    expect(await outcome()).toBeNull();
  });

  it('焦点在授予按钮上时打过字:停顿后再按 Enter 也不授予(打字说明用户没在看弹窗),重新聚焦后才可用', async () => {
    const outcome = prompt();
    button('本次启动期间允许').focus();
    type('fix the bug');
    advance(DELAY * 4);
    press('Enter');
    expect(await outcome()).toBeNull();

    // 用户看到弹窗后:移开焦点再回来,停顿,确认
    button('仅本次').focus();
    button('本次启动期间允许').focus();
    advance(DELAY);
    press('Enter');
    expect(await outcome()).toBe('session');
  });

  it('紧跟在别的按键(非字符键也算)后面的 Enter → 不授予;停顿后再按才授予', async () => {
    const outcome = prompt();
    button('仅本次').focus();
    advance(DELAY);
    press('ArrowUp'); // 例如在终端里翻历史后回车
    advance(DELAY - 1);
    press('Enter');
    expect(await outcome()).toBeNull();
    advance(DELAY);
    press('Enter');
    expect(await outcome()).toBe('once');
  });

  it('按住不放的 Enter(键重复)→ 不授予', async () => {
    const outcome = prompt();
    button('仅本次').focus();
    advance(DELAY);
    press('Enter', { repeat: true });
    press('Enter', { repeat: true });
    expect(await outcome()).toBeNull();
  });

  it.each([
    ['Enter', '仅本次', 'once'],
    [' ', '本次启动期间允许', 'session'],
  ])('键盘可达性保留:Tab 到授予按钮,停顿后按 %j → 授予', async (key, label, expected) => {
    const outcome = prompt();
    tabTo(button('仅本次'));
    if (label !== '仅本次') tabTo(button(label));
    advance(DELAY - 1);
    press(key);
    expect(await outcome()).toBeNull();
    // 上一下按键之后同样要停顿
    advance(DELAY);
    press(key);
    expect(await outcome()).toBe(expected);
  });

  it('鼠标点击不受键盘规则约束:出现延迟过后即有效(即使刚按过键、按钮未聚焦)', async () => {
    const outcome = prompt();
    type('abc');
    fireEvent.click(button('仅本次'), { detail: 1 });
    expect(await outcome()).toBe('once');
  });

  it('「拒绝」的键盘激活与 Esc 不受限制', async () => {
    const outcome = prompt();
    type('abc');
    press('Enter'); // 焦点在「拒绝」
    expect(await outcome()).toBe('denied');

    const second = prompt();
    type('abc');
    press('Escape');
    expect(await second()).toBe('denied');
  });
});

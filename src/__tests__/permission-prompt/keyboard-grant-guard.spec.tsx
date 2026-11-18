// @vitest-environment jsdom
// 安全:插件权限弹窗(manifest / fs-scope)与 agent 授权弹窗共用同一守卫 —— 授予按钮的**键盘**激活须是停顿后的
// 有意按键(按钮已持续聚焦、聚焦期间没打过字、这一下按键之前有停顿),Shift+Tab 不能从第一个可聚焦元素回绕到末尾
// 的授予按钮。鼠标点击只受出现延迟约束;拒绝与 Esc 不受限制。完整场景见 agent-auth-prompt-throttle/
// prompt-keyboard-grant-guard.spec.tsx,这里确认两种插件弹窗都接上了。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { PROMPT_GRANT_ARM_DELAY_MS as DELAY } from '../../lib/use-prompt-grant-guard';

const store = () => usePermissionPromptStore.getState();
const buttons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'));
/** 两种弹窗的按钮顺序都以「拒绝」「授予」收尾。 */
const grantButton = (): HTMLButtonElement => buttons().at(-1)!;
const denyButton = (): HTMLButtonElement => buttons().at(-2)!;
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const focused = (): HTMLElement => document.activeElement as HTMLElement;

/** 在当前焦点元素上按一个键;补上浏览器的按钮键盘激活(Enter / Space = 一次 detail=0 的 click)。 */
function press(key: string, init: { shiftKey?: boolean } = {}): void {
  const el = focused();
  const notPrevented = fireEvent.keyDown(el, { key, ...init });
  if (notPrevented && (key === 'Enter' || key === ' ') && el.tagName === 'BUTTON') {
    fireEvent.click(el, { detail: 0 });
  }
  fireEvent.keyUp(el, { key, ...init });
}
/** Tab 到指定元素(jsdom 不移动焦点,手动补上)。 */
function tabTo(el: HTMLElement): void {
  if (fireEvent.keyDown(focused(), { key: 'Tab' })) el.focus();
}

/** 发起请求并等过出现延迟(初始焦点已落在拒绝按钮),返回结算结果的读取器(未结算 → null)。 */
function track<T>(start: () => Promise<T>): () => Promise<T | null> {
  let settled: T | null = null;
  act(() => {
    void start().then((v) => (settled = v));
  });
  advance(DELAY + 100);
  return async () => {
    await act(async () => {});
    return settled;
  };
}
const manifest = () => track(() => store().request('plugin.a', ['fs', 'network']));
const fsScope = () =>
  track(() =>
    store().requestFsScope({
      requestId: 'req-a',
      pluginId: 'plugin.x',
      scopes: [{ path: '/Users/me', mode: 'rw', displayPath: '~' }],
    }),
  );

function resetStore(): void {
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
    fsScopePending: {},
    fsScopeQueue: [],
    currentFsScope: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  render(<PermissionPrompt />);
});
afterEach(() => {
  cleanup();
  resetStore();
  vi.useRealTimers();
});

describe.each([
  ['fs-scope 文件夹授权弹窗', fsScope, 'grant'],
  ['manifest 权限弹窗', manifest, ['fs', 'network']],
] as const)('%s:授予按钮的键盘激活须是停顿后的有意按键', (_name, open, granted) => {
  it('Tab → Enter 的快速序列落在授予按钮上 → 不授予', async () => {
    const result = open();
    expect(focused()).toBe(denyButton());
    tabTo(grantButton());
    press('Enter');
    press(' ');
    expect(await result()).toBeNull();
  });

  it('焦点在授予按钮上时打字,之后的 Space / Enter(即使停顿过)→ 不授予', async () => {
    const result = open();
    grantButton().focus();
    advance(DELAY);
    press('f');
    press(' ');
    advance(DELAY * 4);
    press('Enter');
    expect(await result()).toBeNull();
  });

  it('键盘可达性保留:Tab 到授予按钮,停顿后按 Enter → 授予', async () => {
    const result = open();
    tabTo(grantButton());
    advance(DELAY);
    press('Enter');
    expect(await result()).toEqual(granted);
  });

  it('鼠标点击只受出现延迟约束', async () => {
    const result = open();
    press('a');
    fireEvent.click(grantButton(), { detail: 1 });
    expect(await result()).toEqual(granted);
  });

  it('Shift+Tab 不能从第一个可聚焦元素回绕到末尾的授予按钮', () => {
    open();
    const first = document.querySelector<HTMLElement>(
      '.wm-modal-content input, .wm-modal-content button',
    )!;
    first.focus();
    press('Tab', { shiftKey: true });
    expect(focused()).toBe(first);
  });
});

describe('拒绝方向不受键盘规则约束', () => {
  it('fs-scope:打字后落在「拒绝」上的 Enter 立即生效', async () => {
    const result = fsScope();
    press('a');
    press('Enter');
    expect(await result()).toBe('deny');
  });

  it('manifest:打字后的 Esc 立即生效', async () => {
    const result = manifest();
    press('a');
    press('Escape');
    expect(await result()).toEqual([]);
  });
});

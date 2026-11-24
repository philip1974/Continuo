// @vitest-environment jsdom
// 安全:插件权限弹窗与 agent 授权弹窗共用同一守卫 —— 被拒掉的指针点击不能留下「可用键盘授予」的焦点(过早的单击
// 把焦点带到「授权选中」/ shell 勾选框上,停顿后的 Enter / Space 落成授予)。完整场景见
// agent-auth-prompt-throttle/prompt-early-click-focus.spec.tsx,这里确认 manifest / fs-scope 弹窗都接上了。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { PROMPT_GRANT_ARM_DELAY_MS as DELAY } from '../../lib/use-prompt-grant-guard';
import type { PermissionKey } from '../../plugins/permissions';
import { advanceInAct as advance } from '../_helpers/react-timers';

const store = () => usePermissionPromptStore.getState();
const buttons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'));
/** 两种弹窗的按钮顺序都以「拒绝」「授予」收尾。 */
const grantButton = (): HTMLButtonElement => buttons().at(-1)!;
const denyButton = (): HTMLButtonElement => buttons().at(-2)!;
const checkboxes = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>('.wm-modal-content input[type="checkbox"]'));
const focused = (): HTMLElement => document.activeElement as HTMLElement;

function press(key: string): void {
  const el = focused();
  const notPrevented = fireEvent.keyDown(el, { key });
  const activates =
    (el.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) ||
    (el.tagName === 'INPUT' && key === ' ');
  if (notPrevented && activates) fireEvent.click(el, { detail: 0 });
  fireEvent.keyUp(el, { key });
}
/** 鼠标单击;'browser':按下没被 preventDefault 才聚焦,'always':总是聚焦(焦点经别的途径已在控件上)。 */
function mouseClick(el: HTMLElement, focus: 'browser' | 'always'): void {
  const down = fireEvent.pointerDown(el) && fireEvent.mouseDown(el, { detail: 1 });
  if (down || focus === 'always') act(() => el.focus());
  fireEvent.mouseUp(el, { detail: 1 });
  fireEvent.click(el, { detail: 1 });
}

/** 发起请求(只等初始焦点落到拒绝按钮,不等出现延迟),返回结算结果的读取器(未结算 → null)。 */
function track<T>(start: () => Promise<T>): () => Promise<T | null> {
  let settled: T | null = null;
  act(() => {
    void start().then((v) => (settled = v));
  });
  advance(30);
  return async () => {
    await act(async () => {});
    return settled;
  };
}
const manifest = (perms: readonly PermissionKey[]) => track(() => store().request('plugin.a', perms));
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
    currentFsScope: null,
    fsScopeQueue: [],
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

describe.each(['browser', 'always'] as const)(
  '插件权限弹窗:过早的点击被拒后,停顿后的键盘按键不落成授予(mousedown 聚焦:%s)',
  (focus) => {
    it('M0:manifest +200ms 单击「授权选中」→ 被拒;+700ms Enter → 未授予任何权限', async () => {
      const granted = manifest(['fs', 'network']);
      advance(170);
      mouseClick(grantButton(), focus);
      expect(await granted()).toBeNull();
      expect(focused()).toBe(denyButton());
      advance(700);
      press('Enter');
      expect(await granted()).toEqual([]);
    });

    it('M0b:manifest +200ms 单击 shell 勾选框 → 被拒;+700ms Space → shell 未被勾上', async () => {
      const granted = manifest(['fs', 'shell']);
      advance(170);
      mouseClick(checkboxes()[1]!, focus);
      expect(checkboxes()[1]!.checked).toBe(false);
      expect(focused()).toBe(denyButton());
      advance(700);
      press(' ');
      // Space 落在「全部拒绝」上
      expect(await granted()).toEqual([]);
    });

    it('fs-scope:+200ms 单击「授权」→ 被拒;+700ms Enter → 未授予', async () => {
      const result = fsScope();
      advance(170);
      mouseClick(grantButton(), focus);
      expect(await result()).toBeNull();
      expect(focused()).toBe(denyButton());
      advance(700);
      press('Enter');
      expect(await result()).toBe('deny');
    });
  },
);

describe('插件权限弹窗:正常路径不回归', () => {
  it('过早的点击被拒 → 等满时间窗 → 再单击「授权选中」→ 授予', async () => {
    const granted = manifest(['fs', 'network']);
    advance(170);
    mouseClick(grantButton(), 'browser');
    advance(DELAY);
    mouseClick(grantButton(), 'browser');
    expect(await granted()).toEqual(['fs', 'network']);
  });

  it('时间窗过后单击 shell 勾选框 → 勾上,焦点照常留在勾选框', () => {
    manifest(['fs', 'shell']);
    advance(DELAY + 100);
    mouseClick(checkboxes()[1]!, 'browser');
    expect(checkboxes()[1]!.checked).toBe(true);
    expect(focused()).toBe(checkboxes()[1]!);
  });

  it('时间窗内取消勾选(拒绝方向)照常立即生效', () => {
    manifest(['fs', 'shell']);
    advance(70);
    mouseClick(checkboxes()[0]!, 'browser');
    expect(checkboxes()[0]!.checked).toBe(false);
  });
});

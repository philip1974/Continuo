// @vitest-environment jsdom
// 安全:manifest 权限弹窗里「全选」与勾选框的**勾上**也是授予方向的状态变更(之后一次「授权选中」就带上它们),
// 与授予按钮受同一守卫约束(出现延迟、只认单击、键盘须是停顿后的有意按键);「全选」不含 `shell`(只能逐项手动
// 勾选)。取消勾选是拒绝方向,不设防。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { PROMPT_GRANT_ARM_DELAY_MS as DELAY } from '../../lib/use-prompt-grant-guard';
import type { PermissionKey } from '../../plugins/permissions';

const store = () => usePermissionPromptStore.getState();
const pointerClick = (el: Element): boolean => fireEvent.click(el, { detail: 1 });
const buttons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'));
const selectAllButton = (): HTMLButtonElement => buttons()[0]!;
const denyButton = (): HTMLButtonElement => buttons().at(-2)!;
const grantButton = (): HTMLButtonElement => buttons().at(-1)!;
const checkboxes = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>('.wm-modal-content input[type="checkbox"]'));
const checked = (): boolean[] => checkboxes().map((c) => c.checked);
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const focused = (): HTMLElement => document.activeElement as HTMLElement;

/** 在当前焦点元素上按一个键;补上浏览器的键盘激活(按钮:Enter / Space;勾选框:Space = 一次 detail=0 的 click)。 */
function press(key: string, init: { shiftKey?: boolean } = {}): void {
  const el = focused();
  const notPrevented = fireEvent.keyDown(el, { key, ...init });
  const activates =
    (el.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) ||
    (el.tagName === 'INPUT' && key === ' ');
  if (notPrevented && activates) fireEvent.click(el, { detail: 0 });
  fireEvent.keyUp(el, { key, ...init });
}
/** (Shift+)Tab 到指定元素(jsdom 不移动焦点,手动补上;keydown 被拦下则焦点不动)。 */
function tabTo(el: HTMLElement, init: { shiftKey?: boolean } = {}): void {
  if (fireEvent.keyDown(focused(), { key: 'Tab', ...init })) el.focus();
}

/** 发起一个 manifest 权限请求(弹窗随之出现,初始焦点已落在「全部拒绝」),返回其结算结果的读取器。 */
function manifest(perms: readonly PermissionKey[]): () => Promise<readonly PermissionKey[] | null> {
  let settled: readonly PermissionKey[] | null = null;
  act(() => {
    void store()
      .request('plugin.a', perms)
      .then((v) => (settled = v));
  });
  advance(30);
  return async () => {
    await act(async () => {});
    return settled;
  };
}

function resetStore(): void {
  usePermissionPromptStore.setState({ pending: null, resolve: null, currentFsScope: null });
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

describe('manifest 权限弹窗:「全选」不含 shell', () => {
  it('审计复现:出现后 50ms 点「全选」、之后点「授权选中」→ shell 不被授予', async () => {
    const granted = manifest(['fs', 'shell']);
    advance(20); // 出现后 50ms
    pointerClick(selectAllButton());
    advance(600);
    expect(checked()).toEqual([true, false]);
    pointerClick(grantButton());
    expect(await granted()).toEqual(['fs']);
  });

  it('延迟过后点「全选」:勾上其余全部,shell 保持未勾选', () => {
    manifest(['fs', 'shell', 'network']);
    pointerClick(checkboxes()[0]!); // 取消 fs(拒绝方向,立即可用)
    pointerClick(checkboxes()[2]!); // 取消 network
    expect(checked()).toEqual([false, false, false]);
    advance(DELAY);
    pointerClick(selectAllButton());
    expect(checked()).toEqual([true, false, true]);
  });

  it('用户已手动勾选的 shell 不会被「全选」取消', () => {
    manifest(['fs', 'shell']);
    advance(DELAY);
    pointerClick(checkboxes()[1]!);
    pointerClick(checkboxes()[0]!); // 取消 fs
    pointerClick(selectAllButton());
    expect(checked()).toEqual([true, true]);
  });

  it('请求里有 shell 时按钮文案如实写明不含 shell;没有 shell 时仍是「全选」', async () => {
    const first = manifest(['fs', 'shell']);
    expect(selectAllButton().textContent).toContain('全选');
    expect(selectAllButton().textContent?.toLowerCase()).toContain('shell');
    pointerClick(denyButton());
    await first();

    manifest(['fs', 'network']);
    expect(selectAllButton().textContent).toBe('全选');
  });
});

describe('manifest 权限弹窗:「全选」与勾上勾选框受授予方向的守卫约束', () => {
  it('出现延迟内点「全选」无效;延迟内被拒的点击重新计时', () => {
    manifest(['fs', 'network', 'shell']);
    pointerClick(checkboxes()[0]!); // 取消 fs
    advance(DELAY - 100);
    pointerClick(selectAllButton());
    expect(checked()).toEqual([false, true, false]);
    advance(DELAY - 1);
    pointerClick(selectAllButton());
    expect(checked()).toEqual([false, true, false]);
    advance(DELAY);
    pointerClick(selectAllButton());
    expect(checked()).toEqual([true, true, false]);
  });

  it('出现延迟内勾上 shell 无效;取消勾选(拒绝方向)立即可用;延迟过后可勾上', () => {
    manifest(['fs', 'shell']);
    pointerClick(checkboxes()[1]!);
    expect(checked()).toEqual([true, false]);
    pointerClick(checkboxes()[0]!);
    expect(checked()).toEqual([false, false]);
    advance(DELAY);
    pointerClick(checkboxes()[1]!);
    expect(checked()).toEqual([false, true]);
  });

  it('双击的第二击(detail=2)不能勾上', () => {
    manifest(['shell']);
    advance(DELAY);
    fireEvent.click(checkboxes()[0]!, { detail: 2 });
    expect(checked()).toEqual([false]);
  });

  it('点在权限行的文字上(label)同样受守卫约束,且按指针点击处理', () => {
    manifest(['fs', 'shell']);
    const shellText = checkboxes()[1]!.closest('label')!.querySelector('div')!;
    // 不走浏览器的 label → 勾选框转发:Chromium 里转发出的 click 是 detail=0(且焦点此刻才到勾选框),会被当成
    // 不满足停顿的键盘激活,鼠标点文字就永远勾不上。
    const forwarded = vi.fn();
    checkboxes()[1]!.addEventListener('click', forwarded);
    pointerClick(shellText);
    expect(forwarded).not.toHaveBeenCalled();
    expect(checked()).toEqual([true, false]);
    advance(DELAY);
    pointerClick(shellText);
    expect(checked()).toEqual([true, true]);
    pointerClick(shellText); // 取消
    expect(checked()).toEqual([true, false]);
  });

  it('键盘:焦点刚到 shell 勾选框就按 Space(输入流里的 Tab Tab Space)→ 不勾上;停顿后有意按 Space 才勾上', () => {
    manifest(['fs', 'shell']);
    advance(DELAY);
    checkboxes()[1]!.focus();
    press(' ');
    expect(checked()).toEqual([true, false]);
    advance(DELAY);
    press(' ');
    expect(checked()).toEqual([true, true]);
    // 取消勾选不受键盘规则约束
    press(' ');
    expect(checked()).toEqual([true, false]);
  });

  it('审计复现:从「全部拒绝」Shift+Tab 到「全选」紧接着 Space → 不全选', () => {
    manifest(['fs', 'network', 'shell']);
    pointerClick(checkboxes()[0]!); // 取消 fs
    advance(DELAY);
    expect(focused()).toBe(denyButton());
    tabTo(selectAllButton(), { shiftKey: true });
    press(' ');
    expect(checked()).toEqual([false, true, false]);
    advance(DELAY);
    press(' ');
    expect(checked()).toEqual([true, true, false]);
  });

  it('Shift+Tab 不能从实际的第一个可聚焦元素(第一个勾选框)回绕到末尾的授予按钮', () => {
    manifest(['fs', 'shell']);
    advance(DELAY);
    const first = checkboxes()[0]!;
    first.focus();
    press('Tab', { shiftKey: true });
    expect(focused()).toBe(first);
  });
});

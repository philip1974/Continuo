// @vitest-environment jsdom
// topic 49 第十八轮 · P1-AU:多 Modal 叠加时 Esc 只关最顶层,不连带关闭背后的弹窗。
//
// 根因:design/Modal 每个实例都在 document 挂独立 keydown 监听,叠加时单次 Esc 触发所有
// 打开 Modal 的 onClose。Continuo 里 CommandPalette 开着时 agent 推来的 AgentAuthPrompt
// (onClose=deny)/ PermissionPrompt(onClose=denyAll)会被这次 Esc 静默拒绝 —— 安全决策被
// 误触发、agent 操作失败且用户不知情。修复:模块级 modalKeyStack,只有栈顶处理键盘。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Modal } from '../../design/Modal';

afterEach(() => cleanup());

function pressEsc(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}

function pressTab(shiftKey = false): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
      }),
    );
  });
}

describe('topic49 P1-AU · 叠加 Modal 的 Esc 只关栈顶', () => {
  it('两个 Modal 叠加 → Esc 只触发后开(栈顶)的 onClose', () => {
    const onCloseBack = vi.fn(); // 背景(如命令面板)
    const onCloseTop = vi.fn(); // 后开(如授权弹窗)
    render(
      <>
        <Modal visible onClose={onCloseBack}>
          <button type="button">back</button>
        </Modal>
        <Modal visible onClose={onCloseTop}>
          <button type="button">top</button>
        </Modal>
      </>,
    );

    pressEsc();
    // 只有栈顶的授权弹窗收到 onClose,背景命令面板不被连带关闭
    expect(onCloseTop).toHaveBeenCalledTimes(1);
    expect(onCloseBack).not.toHaveBeenCalled();
  });

  it('栈顶关闭后 → 下一次 Esc 落到新的栈顶(原背景)', () => {
    const onCloseBack = vi.fn();
    const onCloseTop = vi.fn();
    const { rerender } = render(
      <>
        <Modal visible onClose={onCloseBack}>
          <button type="button">back</button>
        </Modal>
        <Modal visible onClose={onCloseTop}>
          <button type="button">top</button>
        </Modal>
      </>,
    );

    pressEsc();
    expect(onCloseTop).toHaveBeenCalledTimes(1);

    // 顶层 Modal 卸载(从栈移除)
    rerender(
      <>
        <Modal visible onClose={onCloseBack}>
          <button type="button">back</button>
        </Modal>
        <Modal visible={false} onClose={onCloseTop}>
          <button type="button">top</button>
        </Modal>
      </>,
    );

    pressEsc();
    // 现在栈顶是背景 Modal,它才响应
    expect(onCloseBack).toHaveBeenCalledTimes(1);
    expect(onCloseTop).toHaveBeenCalledTimes(1); // 未再增加
  });

  it('单个 Modal(常态)Esc 仍正常关闭(回归)', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <button type="button">x</button>
      </Modal>,
    );
    pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab focus trap 不通过 Array.from 物化 focusable NodeList', () => {
    render(
      <Modal visible>
        <button type="button">first</button>
        <button type="button">last</button>
      </Modal>,
    );
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    buttons[1]!.focus();
    const fromSpy = vi.spyOn(Array, 'from');

    try {
      pressTab();
      expect(document.activeElement).toBe(buttons[0]);
      const nodeListCalls = fromSpy.mock.calls.filter(
        ([arg]) => arg instanceof NodeList,
      );
      expect(nodeListCalls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});

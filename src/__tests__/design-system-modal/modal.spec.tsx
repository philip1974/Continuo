// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { Modal } from '../../design/Modal';

afterEach(() => cleanup());

describe('Modal — 渲染条件', () => {
  it('visible=false → 返 null', () => {
    const { container } = render(
      <Modal visible={false}>
        <button type="button">btn</button>
      </Modal>,
    );
    expect(container.querySelector('.wm-modal-overlay')).toBeNull();
  });

  it('visible=true → 渲染 overlay + content + data-size', () => {
    render(
      <Modal visible size="lg">
        <button type="button">x</button>
      </Modal>,
    );
    const overlay = document.querySelector('.wm-modal-overlay');
    const content = document.querySelector('.wm-modal-content');
    expect(overlay).not.toBeNull();
    expect(content).not.toBeNull();
    expect(content!.getAttribute('data-size')).toBe('lg');
  });

  it('className 与默认 wm-modal-content 合并', () => {
    render(
      <Modal visible className="custom-x">
        <span>x</span>
      </Modal>,
    );
    const content = document.querySelector('.wm-modal-content')!;
    expect(content.className).toContain('custom-x');
    expect(content.className).toContain('wm-modal-content');
  });

  it('默认 size=sm', () => {
    render(
      <Modal visible>
        <span>x</span>
      </Modal>,
    );
    expect(
      document.querySelector('.wm-modal-content')!.getAttribute('data-size'),
    ).toBe('sm');
  });
});

describe('Modal — onClose 路径', () => {
  it('点 overlay → onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <span>x</span>
      </Modal>,
    );
    fireEvent.click(document.querySelector('.wm-modal-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点 content → 不调 onClose(stopPropagation)', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <span data-testid="inner">x</span>
      </Modal>,
    );
    fireEvent.click(document.querySelector('.wm-modal-content')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc → onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <button type="button">btn</button>
      </Modal>,
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('onClose 缺 + Esc → 不抛', () => {
    render(
      <Modal visible>
        <button type="button">btn</button>
      </Modal>,
    );
    expect(() => {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
    }).not.toThrow();
  });

  it('onClose 缺 → overlay onClick=undefined', () => {
    render(
      <Modal visible>
        <span>x</span>
      </Modal>,
    );
    // 点 overlay 不应抛(没有 handler)
    expect(() =>
      fireEvent.click(document.querySelector('.wm-modal-overlay')!),
    ).not.toThrow();
  });
});

describe('Modal — Tab 循环', () => {
  it('Tab 在 last 上 → 跳到 first', () => {
    render(
      <Modal visible>
        <button type="button" data-testid="b1">
          1
        </button>
        <button type="button" data-testid="b2">
          2
        </button>
        <button type="button" data-testid="b3">
          3
        </button>
      </Modal>,
    );
    const b1 = document.querySelector(
      '[data-testid=b1]',
    ) as HTMLButtonElement;
    const b3 = document.querySelector(
      '[data-testid=b3]',
    ) as HTMLButtonElement;
    b3.focus();
    expect(document.activeElement).toBe(b3);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(b1);
  });

  it('Shift+Tab 在 first 上 → 跳到 last', () => {
    render(
      <Modal visible>
        <button type="button" data-testid="b1">
          1
        </button>
        <button type="button" data-testid="b2">
          2
        </button>
      </Modal>,
    );
    const b1 = document.querySelector(
      '[data-testid=b1]',
    ) as HTMLButtonElement;
    const b2 = document.querySelector(
      '[data-testid=b2]',
    ) as HTMLButtonElement;
    b1.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(b2);
  });

  it('没 focusable + Tab → preventDefault(不抛)', () => {
    render(
      <Modal visible>
        <span>no focusable</span>
      </Modal>,
    );
    expect(() => {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }).not.toThrow();
  });
});

describe('Modal — 焦点恢复', () => {
  it('卸载时把焦点还给 prevFocus', async () => {
    // 先在 body 放一个 focusable,模拟触发前的活跃元素
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <Modal visible>
        <button type="button">in</button>
      </Modal>,
    );
    // raf 焦点写到 modal 内,异步发生,这里不强求验证它
    unmount();
    // 卸载副作用同步
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });
});

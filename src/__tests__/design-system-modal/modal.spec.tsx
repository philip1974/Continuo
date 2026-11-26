// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { Modal, getTopModalContent, hasOpenModal, subscribeOpenModals } from '../../design/Modal';

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

describe('Modal — a11y(A10)', () => {
  // overlay 此前误设 aria-hidden="true" 却包裹 content → 屏幕阅读器忽略整个弹窗、焦点
  // trap 进 aria-hidden 子树。修:overlay 不再 aria-hidden,content 标记 role=dialog+aria-modal。
  it('overlay 无 aria-hidden,content 是 role=dialog + aria-modal', () => {
    render(
      <Modal visible>
        <button type="button">x</button>
      </Modal>,
    );
    const overlay = document.querySelector('.wm-modal-overlay')!;
    const content = document.querySelector('.wm-modal-content')!;
    expect(overlay.getAttribute('aria-hidden')).toBeNull();
    expect(content.getAttribute('role')).toBe('dialog');
    expect(content.getAttribute('aria-modal')).toBe('true');
  });

  it('可聚焦内容不在 aria-hidden="true" 子树内', () => {
    render(
      <Modal visible>
        <button type="button" data-testid="inner-btn">go</button>
      </Modal>,
    );
    const btn = document.querySelector('[data-testid=inner-btn]')!;
    // 向上遍历祖先,确认无 aria-hidden="true"
    let el: Element | null = btn;
    let hidden = false;
    while (el) {
      if (el.getAttribute('aria-hidden') === 'true') hidden = true;
      el = el.parentElement;
    }
    expect(hidden).toBe(false);
  });

  // 调用方经 {...rest} 传的 aria-labelledby 须保留(role/aria-modal 置于 rest 前可被覆盖)。
  it('调用方 aria-labelledby 经 rest 保留', () => {
    render(
      <Modal visible aria-labelledby="my-title">
        <span id="my-title">Title</span>
      </Modal>,
    );
    const content = document.querySelector('.wm-modal-content')!;
    expect(content.getAttribute('aria-labelledby')).toBe('my-title');
  });
});

describe('Modal — a11y(A20) 初始焦点', () => {
  // Modal 初始焦点此前总是聚焦第一个可聚焦元素,忽略调用方意图;现优先 [data-autofocus]。
  // rAF 同步化以便断言。
  it('有 [data-autofocus] → 聚焦它而非第一个可聚焦元素', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    try {
      render(
        <Modal visible>
          <button type="button">first</button>
          <button type="button" data-autofocus>
            second
          </button>
        </Modal>,
      );
      const second = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.hasAttribute('data-autofocus'))!;
      expect(document.activeElement).toBe(second);
    } finally {
      raf.mockRestore();
    }
  });

  it('无 [data-autofocus] → 回退第一个可聚焦元素', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    try {
      render(
        <Modal visible>
          <button type="button">first</button>
          <button type="button">second</button>
        </Modal>,
      );
      const first = document.querySelector<HTMLButtonElement>('button')!;
      expect(document.activeElement).toBe(first);
    } finally {
      raf.mockRestore();
    }
  });
});

describe('Modal — onClose 路径', () => {
  it('点 overlay(按下与松开都在遮罩上)→ onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <span>x</span>
      </Modal>,
    );
    const overlay = document.querySelector('.wm-modal-overlay')!;
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 在内容区按下(如拖选输入框文字)、拖到遮罩上松开 → 浏览器把 click 派给两者的公共祖先(遮罩)。
  // 这不是「点遮罩」,不应关闭(命令面板 / Quick Open 会丢查询,授权弹窗的 onClose 是拒绝)。
  it('在内容区按下、拖到遮罩上松开 → 不调 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <input data-testid="q" />
      </Modal>,
    );
    const overlay = document.querySelector('.wm-modal-overlay')!;
    fireEvent.mouseDown(document.querySelector('[data-testid="q"]')!);
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    // 下一次完整的遮罩点击仍能关闭(按下目标不残留)
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('无前置 mousedown 的遮罩 click(如合成点击)→ 不调 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <span>x</span>
      </Modal>,
    );
    const overlay = document.querySelector('.wm-modal-overlay')!;
    fireEvent.mouseDown(document.querySelector('.wm-modal-content')!);
    fireEvent.click(overlay);
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
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

  it('输入法组合中的 Esc(取消候选)→ 不关闭', () => {
    const onClose = vi.fn();
    render(
      <Modal visible onClose={onClose}>
        <button type="button">btn</button>
      </Modal>,
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
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

describe('Modal — 打开后焦点被程序抢走 → 拉回初始焦点', () => {
  // 资源管理器拖动移动确认框:headless-tree 在 drop 回调之后的定时器里轮询聚焦源行(晚于 Modal 的 rAF),
  // 焦点回到树行 → Enter 展开背后的目录。用户操作(按键 / 点按)前焦点移出弹窗须拉回初始焦点。
  const syncRaf = () =>
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  const outsideButton = () => {
    const b = document.createElement('button');
    b.textContent = 'outside';
    document.body.appendChild(b);
    return b;
  };

  it('用户操作前焦点被移到弹窗外 → 拉回 [data-autofocus]', () => {
    const raf = syncRaf();
    const outside = outsideButton();
    try {
      render(
        <Modal visible>
          <button type="button">cancel</button>
          <button type="button" data-autofocus>
            ok
          </button>
        </Modal>,
      );
      const ok = document.querySelector<HTMLButtonElement>('[data-autofocus]')!;
      expect(document.activeElement).toBe(ok);
      outside.focus();
      expect(document.activeElement).toBe(ok);
    } finally {
      raf.mockRestore();
      outside.remove();
    }
  });

  it('用户按键或点按之后,焦点移到弹窗外不再拉回', () => {
    const raf = syncRaf();
    const outside = outsideButton();
    try {
      render(
        <Modal visible>
          <button type="button" data-autofocus>
            ok
          </button>
        </Modal>,
      );
      fireEvent.pointerDown(document.body);
      outside.focus();
      expect(document.activeElement).toBe(outside);
    } finally {
      raf.mockRestore();
      outside.remove();
    }
  });

  it('焦点落到叠加弹出的另一个 Modal 里 → 不拉回', () => {
    const raf = syncRaf();
    try {
      const { rerender } = render(
        <>
          <Modal visible>
            <button type="button" data-autofocus>
              first
            </button>
          </Modal>
          <Modal visible={false}>
            <button type="button">second</button>
          </Modal>
        </>,
      );
      rerender(
        <>
          <Modal visible>
            <button type="button" data-autofocus>
              first
            </button>
          </Modal>
          <Modal visible>
            <button type="button">second</button>
          </Modal>
        </>,
      );
      const second = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'second')!;
      expect(document.activeElement).toBe(second);
    } finally {
      raf.mockRestore();
    }
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

describe('Modal — 打开状态订阅(hasOpenModal / subscribeOpenModals)', () => {
  it('visible Modal 挂载 → hasOpenModal() 为 true;全部关闭 → false;只在有 / 无切换时通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOpenModals(listener);
    expect(hasOpenModal()).toBe(false);

    const { rerender } = render(
      <>
        <Modal visible>a</Modal>
        <Modal visible={false}>b</Modal>
      </>,
    );
    expect(hasOpenModal()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <Modal visible>a</Modal>
        <Modal visible>b</Modal>
      </>,
    );
    expect(listener).toHaveBeenCalledTimes(1); // 叠加第二个不再通知

    rerender(
      <>
        <Modal visible={false}>a</Modal>
        <Modal visible>b</Modal>
      </>,
    );
    expect(hasOpenModal()).toBe(true);
    rerender(
      <>
        <Modal visible={false}>a</Modal>
        <Modal visible={false}>b</Modal>
      </>,
    );
    expect(hasOpenModal()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    rerender(<Modal visible>a</Modal>);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('popout 子窗文档里的 Modal 同样计入', () => {
    const child = document.implementation.createHTMLDocument('popout');
    const host = child.createElement('div');
    child.body.appendChild(host);
    const { unmount } = render(<Modal visible>p</Modal>, { container: host });
    expect(hasOpenModal()).toBe(true);
    unmount();
    expect(hasOpenModal()).toBe(false);
  });
});

describe('Modal — 顶层模态内容查询(getTopModalContent)', () => {
  it('返回该文档最后打开、仍可见的 Modal 内容节点;无模态时为 null;按文档区分', () => {
    expect(getTopModalContent(document)).toBeNull();
    const { rerender } = render(
      <>
        <Modal visible data-testid="a">a</Modal>
        <Modal visible={false} data-testid="b">b</Modal>
      </>,
    );
    expect(getTopModalContent(document)?.getAttribute('data-testid')).toBe('a');
    rerender(
      <>
        <Modal visible data-testid="a">a</Modal>
        <Modal visible data-testid="b">b</Modal>
      </>,
    );
    expect(getTopModalContent(document)?.getAttribute('data-testid')).toBe('b');
    expect(getTopModalContent(document)?.classList.contains('wm-modal-content')).toBe(true);
    const child = document.implementation.createHTMLDocument('popout');
    expect(getTopModalContent(child)).toBeNull();
    rerender(
      <>
        <Modal visible data-testid="a">a</Modal>
        <Modal visible={false} data-testid="b">b</Modal>
      </>,
    );
    expect(getTopModalContent(document)?.getAttribute('data-testid')).toBe('a');
    rerender(<Modal visible={false}>a</Modal>);
    expect(getTopModalContent(document)).toBeNull();
  });
});

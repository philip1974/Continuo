// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { ConfirmDialog } from '../../panels/Explorer/ConfirmDialog';

afterEach(() => cleanup());

function renderD(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return render(
    <ConfirmDialog
      open
      title="确认删除"
      description="此操作不可撤销"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...over}
    />,
  );
}

describe('ConfirmDialog', () => {
  it('open=false shell 直接返回,不订阅 i18n', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/panels/Explorer/ConfirmDialog.tsx'),
      'utf8',
    );
    const shellStart = src.indexOf('export function ConfirmDialog(');
    const bodyStart = src.indexOf('function ConfirmDialogBody');
    const shellSrc = src.slice(shellStart, bodyStart);

    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(bodyStart).toBeGreaterThan(shellStart);
    expect(shellSrc).toContain('if (!open) return null;');
    expect(shellSrc).not.toContain('useT(');
    expect(src.indexOf('const t = useT();')).toBeGreaterThan(bodyStart);
  });

  it('open=false → 不渲染', () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="t"
        description="d"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  it('open=true → 渲染 title + description + 默认按钮', () => {
    renderD({ description: '危险动作' });
    const modal = document.querySelector('.wm-modal-content')!;
    expect(modal.textContent).toContain('确认删除');
    expect(modal.textContent).toContain('危险动作');
    expect(modal.textContent).toContain('确认');
    expect(modal.textContent).toContain('取消');
  });

  it('confirmLabel / cancelLabel 覆盖默认文案', () => {
    renderD({
      title: '删除',
      confirmLabel: 'YES',
      cancelLabel: 'NO',
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toContain('YES');
    expect(labels).toContain('NO');
    expect(labels).not.toContain('确认');
    expect(labels).not.toContain('取消');
  });

  it('destructive=true → 确认按钮 data-variant="danger"', () => {
    renderD({ destructive: true });
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    const confirm = Array.from(buttons).find((b) => b.textContent === '确认')!;
    expect(confirm.getAttribute('data-variant')).toBe('danger');
  });

  it('destructive=false(默认) → 确认按钮 primary', () => {
    renderD();
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    const confirm = Array.from(buttons).find((b) => b.textContent === '确认')!;
    expect(confirm.getAttribute('data-variant')).toBe('primary');
  });

  it('点确认 → onConfirm 被调,onCancel 不调', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderD({ onConfirm, onCancel });
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '确认')!;
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  // a11y(A20):确认按钮排在取消之后,但应是初始焦点(危险操作让用户可直接确认/Esc 取消)。
  // 此前 Modal rAF 总聚焦第一个(取消)按钮覆盖了 autoFocus;改 data-autofocus + Modal 优先。
  it('a11y · 打开后初始焦点落在确认按钮(非取消)', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    try {
      renderD();
      const confirm = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
      ).find((b) => b.textContent === '确认')!;
      expect(confirm.hasAttribute('data-autofocus')).toBe(true);
      expect(document.activeElement).toBe(confirm);
    } finally {
      raf.mockRestore();
    }
  });

  // 数据完整性:destructive 确认框常在用户操作后异步弹出(如 Cmd+S 遇外部修改 → 「仍然覆盖」),
  // 用户继续打的空格 / 回车不能落到破坏性按钮上 —— 初始焦点落「取消」。
  it('destructive=true → 初始焦点落在取消,确认(危险)按钮不带 data-autofocus', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    try {
      renderD({ destructive: true });
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
      );
      const confirm = buttons.find((b) => b.textContent === '确认')!;
      const cancel = buttons.find((b) => b.textContent === '取消')!;
      expect(confirm.hasAttribute('data-autofocus')).toBe(false);
      expect(document.activeElement).toBe(cancel);
    } finally {
      raf.mockRestore();
    }
  });

  it('点取消 → onCancel 被调', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderD({ onConfirm, onCancel });
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '取消')!;
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // 调用方(StatusBar / EditorPanel / PluginsTabContent)都传内联 onCancel:父组件在弹窗
  // 打开期间重渲时,若原样交给 Modal(effect 依赖 onClose),Modal 会 cleanup 再重跑 →
  // 焦点被拉回 [data-autofocus] 确认(危险)按钮、键盘栈重排。onCancel 引用变化不得影响焦点,
  // 且 Esc / 取消仍调用**最新**的 onCancel。
  it('父组件重渲换新 onCancel 引用 → 焦点留在用户 Tab 到的取消按钮;Esc 调最新 onCancel', () => {
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    try {
      const first = vi.fn();
      const { rerender } = render(
        <ConfirmDialog open title="t" description="d" onConfirm={vi.fn()} onCancel={first} />,
      );
      const cancel = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
      ).find((b) => b.textContent === '取消')!;
      cancel.focus();
      expect(document.activeElement).toBe(cancel);

      const latest = vi.fn();
      rerender(
        <ConfirmDialog open title="t" description="d" onConfirm={vi.fn()} onCancel={latest} />,
      );
      expect(document.activeElement).toBe(cancel);

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(latest).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    } finally {
      raf.mockRestore();
    }
  });
});

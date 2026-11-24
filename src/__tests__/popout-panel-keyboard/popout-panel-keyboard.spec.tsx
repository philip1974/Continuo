// @vitest-environment jsdom
// BDD:popout 子窗里的面板弹窗与全局热键。见同目录 README。
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react';
import { Modal } from '../../design/Modal';
import { KeybindingCaptureModal } from '../../plugins/keybindings/KeybindingCaptureModal';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { makeChildDocument, keydown, type ChildDocument } from '../_helpers/child-document';

let child: ChildDocument;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  child = makeChildDocument();
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  child.dispose();
});

const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe('Modal 挂在子窗', () => {
  function Harness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          opener
        </button>
        <Modal
          visible={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button type="button">a</button>
          <button type="button">b</button>
        </Modal>
      </>
    );
  }

  async function openInChild(onClose = vi.fn()) {
    render(<Harness onClose={onClose} />, { container: child.host });
    const q = within(child.doc.body);
    const opener = q.getByText('opener');
    opener.focus();
    fireEvent.click(opener);
    await frame();
    return { q, opener, onClose };
  }

  it('主窗按 Esc 不关;子窗按 Esc 关闭,焦点还原到子窗打开者', async () => {
    const { opener, onClose } = await openInChild();
    act(() => {
      keydown(document, { key: 'Escape' });
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      keydown(child.doc, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(child.doc.activeElement).toBe(opener);
  });

  it('Tab / Shift+Tab 在子窗里循环,不跳出', async () => {
    const { q } = await openInChild();
    const a = q.getByText('a');
    const b = q.getByText('b');
    expect(child.doc.activeElement).toBe(a);
    b.focus();
    let e!: KeyboardEvent;
    act(() => {
      e = keydown(child.doc, { key: 'Tab' });
    });
    expect(e.defaultPrevented).toBe(true);
    expect(child.doc.activeElement).toBe(a);
    act(() => {
      e = keydown(child.doc, { key: 'Tab', shiftKey: true });
    });
    expect(e.defaultPrevented).toBe(true);
    expect(child.doc.activeElement).toBe(b);
  });
});

describe('改键录制弹窗挂在子窗', () => {
  it('子窗里按组合键能录到', () => {
    render(
      <KeybindingCaptureModal
        visible
        commandId="cmd.a"
        commandTitle="Command A"
        currentHotkey={undefined}
        defaultHotkey={undefined}
        allCommands={[]}
        overrides={{}}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onResetToDefault={vi.fn()}
      />,
      { container: child.host },
    );
    const status = () => child.doc.querySelector('.wm-modal-content [role=status]')!.textContent;
    const before = status();
    let e!: KeyboardEvent;
    act(() => {
      e = keydown(child.doc.body, { key: 'k', ctrlKey: true });
    });
    expect(e.defaultPrevented).toBe(true);
    expect(status()).not.toBe(before);
    expect(status()).toContain('K');
  });
});

describe('全局热键只认主窗(子窗不响应)', () => {
  // 命令 / picker 的效果都画在主窗(新终端、设置面板、Quick Open),而从子窗触发时系统焦点留在子窗(renderer 无激活主窗的
  // 通路)—— 接着输入的字进子窗编辑器 / 终端。故全局热键只挂主窗 document;面板内弹窗与改键录制(上方)按所在文档。
  it('命令热键:主窗触发,子窗不触发', () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));
    keydown(child.doc.body, { key: 'k', ctrlKey: true });
    expect(fn).not.toHaveBeenCalled();
    keydown(document.body, { key: 'k', ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('⌘P(Quick Open)在子窗不打开(只认主窗)', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    cleanups.push(() => {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    });
    useQuickOpenStore.setState({ isOpen: false });
    renderHook(() => useQuickOpenHotkey());
    keydown(child.doc.body, { key: 'p', metaKey: true });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    keydown(document.body, { key: 'p', metaKey: true });
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    useQuickOpenStore.setState({ isOpen: false });
  });
});

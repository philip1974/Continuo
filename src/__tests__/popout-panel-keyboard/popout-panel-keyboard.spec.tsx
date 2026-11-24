// @vitest-environment jsdom
// BDD:popout 子窗里的面板弹窗与全局热键。见同目录 README。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import { Modal } from '../../design/Modal';
import { KeybindingCaptureModal } from '../../plugins/keybindings/KeybindingCaptureModal';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import {
  addAppDocumentsListener,
  getAppDocuments,
  registerAppDocument,
} from '../../lib/app-documents';
import { trackPopoutDocuments } from '../../shell/dock/popout-documents';
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

describe('应用文档集合(主窗 + popout 子窗)', () => {
  it('登记的子窗文档收到监听;重复登记只触发一次;注销 / 释放后不再触发', () => {
    const fn = vi.fn();
    const off = addAppDocumentsListener('keydown', fn);
    const unregA = registerAppDocument(child.doc);
    const unregB = registerAppDocument(child.doc);
    keydown(child.doc, { key: 'x' });
    expect(fn).toHaveBeenCalledTimes(1);
    keydown(document, { key: 'x' });
    expect(fn).toHaveBeenCalledTimes(2);
    unregA();
    keydown(child.doc, { key: 'x' });
    expect(fn).toHaveBeenCalledTimes(3); // 仍有一次登记
    unregB();
    keydown(child.doc, { key: 'x' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(getAppDocuments()).toEqual([document]);
    const unregC = registerAppDocument(child.doc);
    off();
    keydown(child.doc, { key: 'x' });
    keydown(document, { key: 'x' });
    expect(fn).toHaveBeenCalledTimes(3);
    unregC();
  });

  it('命令热键在子窗生效,且只触发一次', () => {
    cleanups.push(registerAppDocument(child.doc));
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));
    keydown(child.doc.body, { key: 'k', ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('⌘P(Quick Open)在子窗生效', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    cleanups.push(() => {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    });
    useQuickOpenStore.setState({ isOpen: false });
    cleanups.push(registerAppDocument(child.doc));
    renderHook(() => useQuickOpenHotkey());
    keydown(child.doc.body, { key: 'p', metaKey: true });
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    useQuickOpenStore.setState({ isOpen: false });
  });
});

describe('跟踪 dockview popout 组的窗口', () => {
  type Listener<T> = (v: T) => void;
  function emitter<T>() {
    const ls = new Set<Listener<T>>();
    return {
      event: (l: Listener<T>) => {
        ls.add(l);
        return { dispose: () => ls.delete(l) };
      },
      fire: (v: T) => {
        for (const l of [...ls]) l(v);
      },
      size: () => ls.size,
    };
  }
  function fakeGroup() {
    const loc = emitter<unknown>();
    const group = {
      api: {
        location: { type: 'grid' } as { type: string; getWindow?: () => Window },
        onDidLocationChange: loc.event,
      },
    };
    const moveTo = (location: typeof group.api.location) => {
      group.api.location = location;
      loc.fire({ location });
    };
    return { group, moveTo, loc };
  }
  function fakeApi() {
    const add = emitter<unknown>();
    const remove = emitter<unknown>();
    const groups: unknown[] = [];
    const api = {
      groups,
      onDidAddGroup: add.event,
      onDidRemoveGroup: remove.event,
    };
    return { api: api as unknown as DockviewApi, groups, add, remove };
  }

  it('组弹出 → 子窗文档加入;回到主窗 → 移出;再弹出后组被移除 → 移出;dispose 释放全部', () => {
    const f = fakeApi();
    const g = fakeGroup();
    const tracker = trackPopoutDocuments(f.api);
    f.groups.push(g.group);
    f.add.fire(g.group);
    expect(getAppDocuments()).toEqual([document]);
    g.moveTo({ type: 'popout', getWindow: () => child.win });
    expect(getAppDocuments()).toEqual([document, child.doc]);
    g.moveTo({ type: 'grid' });
    expect(getAppDocuments()).toEqual([document]);
    g.moveTo({ type: 'popout', getWindow: () => child.win });
    f.groups.splice(0);
    f.remove.fire(g.group);
    expect(getAppDocuments()).toEqual([document]);
    expect(g.loc.size()).toBe(0);
    f.groups.push(g.group);
    f.add.fire(g.group);
    expect(getAppDocuments()).toEqual([document, child.doc]);
    tracker.dispose();
    expect(getAppDocuments()).toEqual([document]);
    expect(g.loc.size()).toBe(0);
    expect(f.add.size() + f.remove.size()).toBe(0);
  });

  it('接线守卫:DockShell onReady 挂上跟踪并随 dock 监听一起释放', () => {
    const src = readFileSync(join(process.cwd(), 'src/shell/dock/DockShell.tsx'), 'utf8');
    expect(src).toContain('trackPopoutDocuments(event.api)');
  });
});

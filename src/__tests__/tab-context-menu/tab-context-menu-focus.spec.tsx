// @vitest-environment jsdom
// BDD:从 tab 右键菜单关闭(关闭 / 关闭其他 / 全部关闭…)后的焦点(VSCode:确认框模态、初始焦点在「保存 / 全部保存」;
// 不弹框时同 ⌘W,焦点进新的活动编辑器)。菜单关闭时的焦点还原不得抢走确认框的焦点。见同目录 README「焦点」。
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { setLocale, t } from '../../i18n';
import { TabContextMenu } from '../../lib/TabContextMenu';
import { Modal } from '../../design';

// CodeEditor 替身:视图就绪时按 tab 登记聚焦句柄(同真实引擎)
vi.mock('../../panels/Editor/CodeEditor', async () => {
  const { useEffect, useRef } = await import('react');
  const { registerEditorFocus } = await import('../../panels/Editor/editor-focus-registry');
  return {
    CodeEditor: ({ value, tabId }: { value: string; tabId: string }) => {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => registerEditorFocus(tabId, () => ref.current?.focus()), [tabId]);
      return (
        <div ref={ref} data-testid="code-editor" data-tab={tabId} tabIndex={-1}>
          {value}
        </div>
      );
    },
  };
});
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(async () => ({ ok: true, data: 'orig' })),
      writeFile: vi.fn(async () => ({ ok: true, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';

function tab(path: string, dirty = false): EditorTab {
  return { id: path, filePath: path, content: dirty ? 'mine' : 'orig', originalContent: 'orig', dirty };
}

/** 等菜单关闭后的焦点处理(Radix 在 setTimeout 里还原)与编辑器聚焦请求(下一帧)兑现。 */
// 分多次 act:act 内排队的渲染在 act 结束时才提交,确认框挂载后的初始聚焦(下一帧)要在后一轮 act 里等。
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
  }
}

const tabEl = (name: string) => screen.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) });

/** 右键 name 的 tab(右键按下先聚焦它,同 Chromium)→ 选菜单项 label。 */
async function fromMenu(name: string, label: string) {
  const el = tabEl(name);
  el.focus();
  fireEvent.contextMenu(el);
  const item = screen.getByRole('menuitem', { name: label });
  item.focus();
  fireEvent.click(item);
  await settle();
}

beforeEach(() => setLocale('en'));
afterEach(() => cleanup());

async function mount(tabs: EditorTab[]) {
  useEditorStore.setState({ tabs, activeTabId: tabs[0]!.id, mode: 'source' });
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
}

describe('tab 右键菜单关闭 → 确认框拿到焦点', () => {
  // 确认框挂载即聚焦(rAF 同步执行):真机上确认框的初始聚焦可能早于菜单卸载后 setTimeout 里的焦点还原,
  // 这里固定成「先聚焦确认框、后还原」的次序 —— 还原若不让路,就会把焦点抢回背后的 tab。
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('全部关闭遇多个脏文件 → 合并框的「全部保存」获焦(不留在背后的 tab 上)', async () => {
    await mount([tab(A, true), tab(B), tab(C, true)]);
    await fromMenu('b.ts', 'Close All');
    const saveAll = screen.getByRole('button', { name: t('dialog.unsaved_close.save_all') });
    expect(document.activeElement).toBe(saveAll);
  });

  it('关闭其他遇一个脏文件 → 单文件确认框的「保存」获焦', async () => {
    await mount([tab(A, true), tab(B), tab(C)]);
    await fromMenu('b.ts', 'Close Others');
    expect(screen.getByText(t('panels.editor.save_changes_title', { name: 'a.ts' }))).toBeTruthy();
    const save = screen.getByRole('button', { name: t('common.save') });
    expect(document.activeElement).toBe(save);
  });
});

describe('tab 右键菜单关闭,无脏文件(不弹框)→ 同 ⌘W', () => {
  it('关闭其他关掉活动 tab → 新的活动编辑器获焦', async () => {
    await mount([tab(A), tab(B), tab(C)]);
    await fromMenu('b.ts', 'Close Others');
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([B]);
    expect(document.activeElement).toBe(screen.getByTestId('code-editor'));
    expect(screen.getByTestId('code-editor').dataset.tab).toBe(B);
  });

  it('关闭活动 tab → 新的活动编辑器获焦', async () => {
    await mount([tab(A), tab(B), tab(C)]);
    await fromMenu('a.ts', 'Close');
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([B, C]);
    expect(document.activeElement).toBe(screen.getByTestId('code-editor'));
  });
});

// dock 面板 tab(SharedTab:终端运行中程序的关闭确认)与编辑器 tab 共用 TabContextMenu 外壳:opensDialog 项的语义在外壳上。
describe('TabContextMenu opensDialog 项', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <TabContextMenu entries={() => [{ label: 'Close', onSelect: () => setOpen(true), opensDialog: true }]}>
          <div role="tab" tabIndex={0}>
            t1
          </div>
        </TabContextMenu>
        <Modal visible={open} onClose={() => setOpen(false)} aria-label="confirm">
          <button type="button" data-autofocus>
            confirm-ok
          </button>
        </Modal>
      </>
    );
  }

  it('动作打开的确认框拿到焦点(菜单关闭的焦点还原不抢回 tab)', async () => {
    render(<Harness />);
    await fromMenu('t1', 'Close');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'confirm-ok' }));
  });
});

// popout 子窗:tab 与菜单在子窗文档,代码跑在主窗(全局 document 是主窗)。Radix FocusScope 按全局 document 记录 / 还原
// 打开前焦点 → 子窗里关闭菜单后焦点落到子窗 body。期望同主窗(VSCode 辅助窗口取消关闭确认焦点回该编辑器):回到触发 tab。
describe('popout 子窗里的 tab 右键菜单', () => {
  let child: Document;
  let frame: HTMLIFrameElement;
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
    child = frame.contentDocument!;
    // 主窗里另有焦点(如主窗编辑器):Radix 记下的就是它
    const mainBtn = document.createElement('button');
    mainBtn.textContent = 'main';
    document.body.appendChild(mainBtn);
    mainBtn.focus();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function ChildHarness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <TabContextMenu
          entries={() => [
            { label: 'Close', onSelect: () => setOpen(true), opensDialog: true },
            { label: 'Copy Path', onSelect: () => undefined },
          ]}
        >
          {/* 同编辑器 tab:触发区是 display:contents 包裹层(不可聚焦),tab 在其内 */}
          <div className="contents">
            <div role="tab" tabIndex={0}>
              t1
            </div>
          </div>
        </TabContextMenu>
        <Modal
          visible={open}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          aria-label="confirm"
        >
          <button type="button" data-autofocus>
            confirm-ok
          </button>
        </Modal>
      </>
    );
  }

  function mountInChild() {
    const host = child.createElement('div');
    child.body.appendChild(host);
    render(<ChildHarness onClose={() => undefined} />, { container: host });
    const tabNode = within(child.body).getByRole('tab', { name: 't1' });
    tabNode.focus();
    fireEvent.contextMenu(tabNode);
    return tabNode;
  }

  it('「关闭」→ 确认框 → Esc 取消 → 焦点回到子窗里的触发 tab', async () => {
    const tabNode = mountInChild();
    const item = within(child.body).getByRole('menuitem', { name: 'Close' });
    item.focus();
    fireEvent.click(item);
    await settle();
    const ok = within(child.body).getByRole('button', { name: 'confirm-ok' });
    expect(child.activeElement).toBe(ok);
    fireEvent.keyDown(child, { key: 'Escape' });
    await settle();
    expect(within(child.body).queryByRole('button', { name: 'confirm-ok' })).toBeNull();
    expect(child.activeElement).toBe(tabNode);
  });

  it('菜单直接 Esc → 焦点回到子窗里的触发 tab', async () => {
    const tabNode = mountInChild();
    const item = within(child.body).getByRole('menuitem', { name: 'Copy Path' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Escape' });
    await settle();
    expect(within(child.body).queryByRole('menu')).toBeNull();
    expect(child.activeElement).toBe(tabNode);
  });

  it('点菜单外部关闭 → 不把焦点拉回 tab(同 Radix 默认)', async () => {
    mountInChild();
    await settle(); // Radix 在下一任务才挂外部点按监听
    const outside = child.createElement('button');
    child.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    outside.focus();
    await settle();
    expect(within(child.body).queryByRole('menu')).toBeNull();
    expect(child.activeElement).toBe(outside);
  });
});

// @vitest-environment jsdom
// 依据 tab dirty / content / id 做决定的入口先同步回写编辑器里尚未上抛的输入(见同目录 README.md)。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import {
  applyEditorWriteBack,
  registerEditorWriteBack,
} from '../../panels/Editor/editor-writeback-registry';
import { t } from '../../i18n';

// 模拟 Milkdown:pending = 编辑器里尚未上抛 store 的全文。与真实实现同口径 —— 登记同步回写句柄,
// 用最近一次渲染的 onWriteBack(闭包持渲染时的 tab id),基线 = 挂载时内容;只读预览不回写。
const harness = vi.hoisted(() => ({ pending: null as string | null }));

vi.mock('../../panels/Editor/MilkdownEditor', async () => {
  const ReactMod = await import('react');
  const { registerEditorWriteBack: register } = await import(
    '../../panels/Editor/editor-writeback-registry'
  );
  type Props = {
    defaultValue: string;
    readonly?: boolean;
    onWriteBack?: (md: string, base: string) => void;
  };
  return {
    MilkdownEditor: (props: Props) => {
      const propsRef = ReactMod.useRef(props);
      propsRef.current = props;
      const baseRef = ReactMod.useRef(props.defaultValue);
      ReactMod.useEffect(
        () =>
          register(() => {
            if (propsRef.current.readonly || harness.pending === null) return;
            const md = harness.pending;
            harness.pending = null;
            propsRef.current.onWriteBack?.(md, baseRef.current);
          }),
        [],
      );
      return (
        <div data-testid={props.readonly ? 'milkdown-preview' : 'milkdown-edit'}>
          {props.defaultValue}
        </div>
      );
    },
  };
});
vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(async () => ({ ok: true, data: 'hello' })),
      writeFile: vi.fn(async () => ({ ok: true, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn() },
}));

const PATH = '/w/a.md';

async function renderPanel() {
  render(<EditorPanel />);
  await act(async () => {
    await import('../../panels/Editor/CodeEditor');
    await import('../../panels/Editor/MilkdownEditor');
  });
}

beforeEach(() => {
  harness.pending = null;
  useEditorStore.setState({
    tabs: [createTab(PATH, 'hello')],
    activeTabId: PATH,
    mode: 'edit',
  });
});
afterEach(() => {
  cleanup();
  harness.pending = null;
});

describe('EditorPanel:决定前先回写未上抛输入', () => {
  it('关闭 store 里仍干净、但编辑器有未上抛输入的 tab → 弹「放弃修改?」,不直接关闭丢弃', async () => {
    await renderPanel();
    harness.pending = 'hello typed';

    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.md' }) }));

    expect(screen.getByText(t('panels.editor.discard_title'))).toBeTruthy();
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.content).toBe('hello typed');
    expect(tab?.dirty).toBe(true);
  });

  it('无未上抛输入的干净 tab → 照常直接关闭', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.md' }) }));
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it('Edit 切 Preview → 预览显示最新输入,而非切换前 store 里的旧内容', async () => {
    await renderPanel();
    harness.pending = 'hello typed';

    fireEvent.click(screen.getByRole('radio', { name: t('panels.editor.mode.preview') }));

    expect(screen.getByTestId('milkdown-preview').textContent).toBe('hello typed');
  });

  it('Edit 切 Source → 源码视图显示最新输入', async () => {
    await renderPanel();
    harness.pending = 'hello typed';

    fireEvent.click(screen.getByRole('radio', { name: t('panels.editor.mode.source') }));

    expect((await screen.findByTestId('code-editor')).textContent).toBe('hello typed');
  });
});

describe('editor store:按 dirty / id 决定的动作先回写未上抛输入', () => {
  // 回写句柄的闭包绑定挂载时的 tab id(同 EditorPanel 传给 Milkdown 的 onWriteBack)
  let off: (() => void) | null = null;
  function pendingInput(md: string, tabId = PATH, base = 'hello'): void {
    harness.pending = md;
    off = registerEditorWriteBack(() => {
      if (harness.pending === null) return;
      const v = harness.pending;
      harness.pending = null;
      applyEditorWriteBack(useEditorStore, tabId, v, base);
    });
  }
  afterEach(() => {
    off?.();
    off = null;
  });

  it('外部改盘 reloadFromDisk → 未上抛输入不被磁盘内容覆盖,tab 变脏保留', () => {
    pendingInput('hello typed');
    useEditorStore.getState().reloadFromDisk(PATH, 'external');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.content).toBe('hello typed');
    expect(tab?.dirty).toBe(true);
  });

  it('改名 / 移动 renamePath(换 tab id)→ 输入随 tab 一起改名,不因旧 id 找不到 tab 丢弃', () => {
    pendingInput('hello typed');
    useEditorStore.getState().renamePath(PATH, '/w/b.md');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.id).toBe('/w/b.md');
    expect(tab?.content).toBe('hello typed');
    expect(tab?.dirty).toBe(true);
  });

  it('setFilePath(换 tab id)→ 输入随 tab 保留', () => {
    pendingInput('hello typed');
    useEditorStore.getState().setFilePath(PATH, '/w/c.md');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.id).toBe('/w/c.md');
    expect(tab?.content).toBe('hello typed');
  });

  it('删除打开中的文件 removePaths → tab 因未上抛输入变脏而保留', () => {
    pendingInput('hello typed');
    useEditorStore.getState().removePaths([PATH]);
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.content).toBe('hello typed');
    expect(tab?.dirty).toBe(true);
  });

  it('删除打开中的文件 removePath → 同上', () => {
    pendingInput('hello typed');
    useEditorStore.getState().removePath(PATH);
    expect(useEditorStore.getState().tabs[0]?.content).toBe('hello typed');
  });

  it('切工作区 root closeTabsOutsideRoot → tab 因未上抛输入变脏而保留', () => {
    pendingInput('hello typed');
    useEditorStore.getState().closeTabsOutsideRoot('/other');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.content).toBe('hello typed');
    expect(tab?.dirty).toBe(true);
  });

  it('setMode 切换模式 → 切换前回写;模式不变不回写', () => {
    pendingInput('hello typed');
    useEditorStore.getState().setMode('edit'); // 不变
    expect(useEditorStore.getState().tabs[0]?.content).toBe('hello');
    useEditorStore.getState().setMode('preview');
    expect(useEditorStore.getState().tabs[0]?.content).toBe('hello typed');
  });
});

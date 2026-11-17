// @vitest-environment jsdom
// 依据 tab dirty / content / id 做决定的入口先同步回写编辑器里尚未上抛的输入(见同目录 README.md)。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
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
});

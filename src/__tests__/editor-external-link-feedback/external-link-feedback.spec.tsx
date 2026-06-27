// @vitest-environment jsdom
// a11y(A117,A50/A116 同族):Markdown 外链点击经 coApi.shell.openExternal,失败(白名单拒绝/
// 系统打开失败/IPC reject)须 notify.error 反馈,不被 void 丢弃(用户只感知链接「没反应」)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, act, waitFor } from '@testing-library/react';

// hoisted:vi.mock 工厂被提升到文件顶,内部不能引用普通顶层变量 → 用 vi.hoisted 共享。
const h = vi.hoisted(() => ({
  openExternal: vi.fn(),
  notifyError: vi.fn(),
  openFileByPath: vi.fn(),
  onLinkClick: { current: null as ((href: string) => void) | null },
}));

vi.mock('../../panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: h.openFileByPath }),
}));

vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: (props: { onLinkClick?: (href: string) => void }) => {
    h.onLinkClick.current = props.onLinkClick ?? null;
    return <div data-testid="milkdown-editor" />;
  },
}));
vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: h.openExternal },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { error: h.notifyError },
}));

const openExternalMock = h.openExternal;
const notifyErrorMock = h.notifyError;

import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';

beforeEach(() => {
  h.onLinkClick.current = null;
  openExternalMock.mockReset();
  notifyErrorMock.mockReset();
  h.openFileByPath.mockReset();
  h.openFileByPath.mockResolvedValue({ ok: true });
  useEditorStore.setState({
    // .md + 安全内容(无 frontmatter/wiki-link)→ getEffectiveMode 非 source → 渲染 Milkdown。
    tabs: [
      {
        id: '/a.md',
        filePath: '/a.md',
        content: 'hello',
        originalContent: 'hello',
        dirty: false,
      },
    ],
    activeTabId: '/a.md',
    mode: 'edit',
  });
});
afterEach(() => cleanup());

describe('a11y(A117) — Markdown 外链打开失败须有反馈', () => {
  it('openExternal {ok:false} → notify.error', async () => {
    openExternalMock.mockResolvedValue({ ok: false, code: 'CO_COMMAND_BLOCKED' });
    render(<EditorPanel />);
    expect(h.onLinkClick.current).not.toBeNull();
    act(() => {
      h.onLinkClick.current!('https://example.com');
    });
    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledWith('https://example.com');
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
  });

  it('openExternal reject(IPC 异常)→ notify.error,不静默', async () => {
    openExternalMock.mockRejectedValue(new Error('ipc down'));
    render(<EditorPanel />);
    act(() => {
      h.onLinkClick.current!('https://example.com');
    });
    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
  });

  it('openExternal {ok:true} → 不报错', async () => {
    openExternalMock.mockResolvedValue({ ok: true, data: undefined });
    render(<EditorPanel />);
    act(() => {
      h.onLinkClick.current!('https://example.com');
    });
    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalled();
    });
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  // a11y(A127,A117 同族):本地文件链接打开失败({ok:false}/reject)也须 notify.error。
  it('本地文件链接 openFileByPath {ok:false} → notify.error', async () => {
    h.openFileByPath.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND' });
    render(<EditorPanel />);
    act(() => {
      h.onLinkClick.current!('./other.md'); // 相对路径 → file 分支
    });
    await waitFor(() => {
      expect(h.openFileByPath).toHaveBeenCalled();
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
  });

  it('本地文件链接 openFileByPath reject → notify.error', async () => {
    h.openFileByPath.mockRejectedValue(new Error('io error'));
    render(<EditorPanel />);
    act(() => {
      h.onLinkClick.current!('./other.md');
    });
    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
  });
});

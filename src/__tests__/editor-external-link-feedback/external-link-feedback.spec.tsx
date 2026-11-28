// @vitest-environment jsdom
// a11y(A117,A50/A116 同族):Markdown 外链点击经 coApi.shell.openExternal,失败(白名单拒绝/
// 系统打开失败/IPC reject)须 notify.error 反馈,不被 void 丢弃(用户只感知链接「没反应」)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, act, waitFor } from '@testing-library/react';

// hoisted:vi.mock 工厂被提升到文件顶,内部不能引用普通顶层变量 → 用 vi.hoisted 共享。
const h = vi.hoisted(() => ({
  openExternal: vi.fn(),
  notifyError: vi.fn(),
  notifyWarn: vi.fn(),
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
  notify: { error: h.notifyError, warn: h.notifyWarn },
}));

// perf E2:EditorPanel 内编辑引擎 lazy 加载 → render 后须等引擎模块解析、Suspense 重试完成再断言。
async function flushLazyEditors() {
  await act(async () => {
    await import('../../panels/Editor/CodeEditor');
    await import('../../panels/Editor/MilkdownEditor');
  });
}

const openExternalMock = h.openExternal;
const notifyErrorMock = h.notifyError;

import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { t } from '../../i18n';

beforeEach(() => {
  h.onLinkClick.current = null;
  openExternalMock.mockReset();
  notifyErrorMock.mockReset();
  h.notifyWarn.mockReset();
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
    await flushLazyEditors();
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
    await flushLazyEditors();
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
    await flushLazyEditors();
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
    await flushLazyEditors();
    act(() => {
      h.onLinkClick.current!('./other.md'); // 相对路径 → file 分支
    });
    await waitFor(() => {
      expect(h.openFileByPath).toHaveBeenCalled();
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
    // 与 Explorer / Quick Open 同一「打开失败 <文件名>: 原因」提示(notifyOpenFailed),带文件名。
    expect(String(notifyErrorMock.mock.calls[0]?.[0])).toContain('other.md');
  });

  it('本地文件链接 openFileByPath reject → notify.error', async () => {
    h.openFileByPath.mockRejectedValue(new Error('io error'));
    render(<EditorPanel />);
    await flushLazyEditors();
    act(() => {
      h.onLinkClick.current!('./other.md');
    });
    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    });
    expect(String(notifyErrorMock.mock.calls[0]?.[0])).toContain('other.md');
  });

  // 第 6 项:不安全 / 未知 scheme 的链接此前点了静默无反应 → 提示「出于安全原因未打开此链接:<scheme>」,同一 scheme 只留一条。
  it('不安全 / 未知 scheme → notify.warn 说明原因(带 scheme、按 scheme 去重),不调 openExternal', async () => {
    render(<EditorPanel />);
    await flushLazyEditors();
    act(() => {
      h.onLinkClick.current!('javascript:alert(1)');
      h.onLinkClick.current!('JavaScript:void(0)');
      h.onLinkClick.current!('vscode://evil/x');
      h.onLinkClick.current!('file:///etc/passwd');
    });
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(h.notifyWarn.mock.calls.map((c) => [c[0], c[1]?.replaceKey])).toEqual([
      [t('panels.editor.link.blocked_scheme', { scheme: 'javascript' }), 'editor.link-blocked:javascript'],
      [t('panels.editor.link.blocked_scheme', { scheme: 'javascript' }), 'editor.link-blocked:javascript'],
      [t('panels.editor.link.blocked_scheme', { scheme: 'vscode' }), 'editor.link-blocked:vscode'],
      [t('panels.editor.link.blocked_scheme', { scheme: 'file' }), 'editor.link-blocked:file'],
    ]);
  });

  it('空链接 / 无法解析的相对路径等不是 scheme 问题 → 不提示', async () => {
    render(<EditorPanel />);
    await flushLazyEditors();
    act(() => {
      h.onLinkClick.current!('#');
      h.onLinkClick.current!('C:\\Windows\\x.md');
    });
    expect(h.notifyWarn).not.toHaveBeenCalled();
  });
});

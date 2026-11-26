// @vitest-environment jsdom
// 打开图片文件 → 只读图片视图(不读成文本);⌘S no-op;超限提示;外部修改按 stat 指纹重载;视图可聚焦且有名称。
// 行为见同目录 README。被测:editor-file-actions / editor-file-deps / editor-image / ImageViewer / EditorPanel / useExternalFileSync。
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { openFileByPath, saveFile } from '../../panels/Editor/editor-file-actions';
import { editorFileDeps } from '../../panels/Editor/editor-file-deps';
import { requestEditorFocus } from '../../panels/Editor/editor-focus-registry';
import { useExternalFileSync } from '../../panels/Editor/useExternalFileSync';
import { focusPanelContent } from '../../shell/dock/panel-focus';
import type { DockviewPanelApi } from 'dockview-react';
import { t } from '../../i18n';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  readImage: vi.fn(),
  dirChanged: [] as Array<(dir: string, files?: readonly string[]) => void>,
  error: vi.fn(),
}));

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: () => <div data-testid="code-editor" />,
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      stat: mocks.stat,
      readImage: mocks.readImage,
      onDirChanged: (cb: (dir: string, files?: readonly string[]) => void) => {
        mocks.dirChanged.push(cb);
        return () => {};
      },
      onRootPresenceChanged: () => () => {},
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: mocks.error, info: vi.fn(), success: vi.fn() },
}));

const PATH = '/w/a.png';
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const NOT_UTF8 = { ok: false, code: 'FS_NOT_UTF8', message: 'file is not valid UTF-8' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dirChanged.length = 0;
  mocks.readFile.mockResolvedValue(NOT_UTF8);
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  mocks.stat.mockResolvedValue({ ok: true, data: { mtimeMs: 1.5, size: 2048, ino: 7 } });
  mocks.readImage.mockResolvedValue({ ok: true, data: { dataUrl: DATA_URL, size: 2048 } });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tabOf = () => useEditorStore.getState().tabs.find((x) => x.id === PATH);
const viewerName = () => t('editor.image.aria', { name: 'a.png' });

async function openAndRender() {
  expect(await openFileByPath(PATH, editorFileDeps)).toEqual({ ok: true, data: undefined });
  render(<EditorPanel />);
  return screen.findByRole('img', { name: viewerName() });
}

describe('打开图片文件', () => {
  it('png 不走文本 readFile(不报 FS_NOT_UTF8),按 stat 建 tab,tab 不脏', async () => {
    expect(await openFileByPath(PATH, editorFileDeps)).toEqual({ ok: true, data: undefined });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.stat).toHaveBeenCalledWith(PATH);
    expect(tabOf()?.dirty).toBe(false);
    expect(useEditorStore.getState().activeTabId).toBe(PATH);
  });

  it('svg 照 VSCode 仍按文本打开(走 readFile)', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: '<svg/>' });
    await openFileByPath('/w/a.svg', editorFileDeps);
    expect(mocks.readFile).toHaveBeenCalledWith('/w/a.svg');
  });

  it('编辑区渲染只读图片视图:名称「<文件名>，图片预览」,经 readImage 读 data URL,显示尺寸与大小', async () => {
    const viewer = await openAndRender();
    expect(mocks.readImage).toHaveBeenCalledWith(PATH);
    const img = viewer.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(DATA_URL);
    Object.defineProperty(img, 'naturalWidth', { value: 640 });
    Object.defineProperty(img, 'naturalHeight', { value: 480 });
    fireEvent.load(img);
    expect(await screen.findByText(/640x480/)).toBeTruthy();
    expect(screen.getByText(/2\.00KB/)).toBeTruthy();
    expect(screen.queryByTestId('code-editor')).toBeNull();
    expect(viewer.tabIndex).toBe(0);
  });

  it('⌘S 在图片 tab 上无操作:不写盘、不报错;saveFile 直接成功', async () => {
    const viewer = await openAndRender();
    await act(async () => {
      fireEvent.keyDown(viewer, { key: 's', ...MOD });
    });
    expect(await saveFile(PATH, editorFileDeps)).toEqual({ ok: true, data: undefined });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('超过上限 → 视图显示「图片过大」提示,不弹错误 toast', async () => {
    mocks.readImage.mockResolvedValue({ ok: false, code: 'FS_FILE_TOO_LARGE', message: 'too large' });
    await openFileByPath(PATH, editorFileDeps);
    render(<EditorPanel />);
    expect(await screen.findByText(t('editor.image.too_large', { max: '50MB' }))).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('打开后焦点请求落到图片视图根', async () => {
    const viewer = await openAndRender();
    act(() => requestEditorFocus(PATH));
    expect(document.activeElement).toBe(viewer);
  });

  it('F6 / 点 dock tab 把焦点交给面板内容时落到图片视图(而不是面板根)', async () => {
    const viewer = await openAndRender();
    const element = viewer.closest('[data-editor-panel-root]')!.parentElement!;
    const api = { id: 'editor', group: { panels: [{ id: 'editor', view: { content: { element } } }] } };
    act(() => focusPanelContent(api as unknown as DockviewPanelApi));
    expect(document.activeElement).toBe(viewer);
  });
});

describe('外部修改', () => {
  it('dir-changed 命中图片 tab → 只 stat;指纹变化 → reloadEpoch 递增(视图重新读图)', async () => {
    await openFileByPath(PATH, editorFileDeps);
    renderHook(() => useExternalFileSync());
    mocks.stat.mockResolvedValue({ ok: true, data: { mtimeMs: 9.5, size: 4096, ino: 7 } });
    await act(async () => {
      for (const cb of mocks.dirChanged) cb('/w', ['a.png']);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(tabOf()?.reloadEpoch).toBe(1);
    expect(tabOf()?.dirty).toBe(false);
  });
});

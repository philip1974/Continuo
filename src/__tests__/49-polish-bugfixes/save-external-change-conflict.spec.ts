// 打磨 P2-BL:dirty tab 外部修改后保存静默覆盖外部版本。useExternalFileSync 对 dirty tab 跳过
// reload(保护用户编辑),保存此前又不比较磁盘 → 外部改动被无声抹掉。参考 VSCode「文件已在磁盘上
// 更改」:保存前读盘,若 ≠ tab.originalContent(自上次加载/保存后被外部改过)→ 返回
// EDITOR_DISK_CHANGED 不写;显式保存由 UI 确认后以 force 覆盖。只有明确「不存在」(FS_NOT_FOUND,
// main readFile 对 ENOENT 的映射)才照常写(允许重建);其它读错误(EACCES/EIO/bridge reject)无法确认
// 磁盘状态 → 中止保存、保留 dirty、返回该错误(复审:此前任意读错误都按无冲突写)。
// 被测:editor-file-actions.ts saveFile。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveFile, type EditorFileDeps } from '@/panels/Editor/editor-file-actions';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import type { IpcResult } from '@/lib/fs/types';

const okRead = (data: string): IpcResult<string> => ({ ok: true, data });
const okWrite = (): IpcResult<void> => ({ ok: true, data: undefined });

function setup(readFile: EditorFileDeps['fs']['readFile']) {
  const writeFile = vi.fn(async (_p: string, _c: string) => okWrite());
  const deps: EditorFileDeps = { fs: { readFile, writeFile }, store: useEditorStore };
  return { deps, writeFile };
}

const tab = () => findEditorFileTabById(useEditorStore.getState().tabs, '/x/a.md');

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  useEditorStore.getState().openTab(createTab('/x/a.md', 'orig'));
  useEditorStore.getState().updateContent('/x/a.md', 'mine');
});

describe('saveFile — 外部修改冲突检测', () => {
  it('磁盘内容 ≠ originalContent → EDITOR_DISK_CHANGED,不写盘,保持 dirty', async () => {
    const { deps, writeFile } = setup(vi.fn(async () => okRead('theirs')));
    const r = await saveFile('/x/a.md', deps);
    expect(r).toMatchObject({ ok: false, code: 'EDITOR_DISK_CHANGED' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(tab()?.dirty).toBe(true);
  });

  it('force:true(用户确认覆盖)→ 不读盘比较,写盘并 markSaved', async () => {
    const readFile = vi.fn(async () => okRead('theirs'));
    const { deps, writeFile } = setup(readFile);
    const r = await saveFile('/x/a.md', deps, { force: true });
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/x/a.md', 'mine');
    expect(tab()?.dirty).toBe(false);
  });

  it('磁盘内容 === originalContent(未被外部改)→ 正常写盘', async () => {
    const { deps, writeFile } = setup(vi.fn(async () => okRead('orig')));
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/x/a.md', 'mine');
  });

  it('读盘 {ok:false}(文件被删 FS_NOT_FOUND)→ 不阻塞,写盘重建', async () => {
    const { deps, writeFile } = setup(
      vi.fn(async (): Promise<IpcResult<string>> => ({
        ok: false,
        code: 'FS_NOT_FOUND',
        message: 'gone',
      })),
    );
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('读盘 reject 且带 FS_NOT_FOUND → 视为文件被删,写盘重建', async () => {
    const { deps, writeFile } = setup(
      vi.fn(async (): Promise<IpcResult<string>> => {
        throw Object.assign(new Error('gone'), { code: 'FS_NOT_FOUND' });
      }),
    );
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('读盘 {ok:false} 非 FS_NOT_FOUND(如 FS_DENIED)→ 中止保存,返回该错误,保持 dirty', async () => {
    const { deps, writeFile } = setup(
      vi.fn(async (): Promise<IpcResult<string>> => ({
        ok: false,
        code: 'FS_DENIED',
        message: 'denied',
      })),
    );
    const r = await saveFile('/x/a.md', deps);
    expect(r).toMatchObject({ ok: false, code: 'FS_DENIED' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(tab()?.dirty).toBe(true);
  });

  it('读盘 reject(无 code / 非 FS_NOT_FOUND)→ 中止保存,返回错误,保持 dirty', async () => {
    const { deps, writeFile } = setup(
      vi.fn(async (): Promise<IpcResult<string>> => {
        throw new Error('bridge');
      }),
    );
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(false);
    expect(r).not.toMatchObject({ code: 'EDITOR_DISK_CHANGED' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(tab()?.dirty).toBe(true);
  });

  it('保存成功后 originalContent 推进 → 再次保存不误报冲突', async () => {
    let disk = 'orig';
    const writeFile = vi.fn(async (_p: string, c: string) => {
      disk = c;
      return okWrite();
    });
    const deps: EditorFileDeps = {
      fs: { readFile: vi.fn(async () => okRead(disk)), writeFile },
      store: useEditorStore,
    };
    expect((await saveFile('/x/a.md', deps)).ok).toBe(true);
    useEditorStore.getState().updateContent('/x/a.md', 'mine2');
    expect((await saveFile('/x/a.md', deps)).ok).toBe(true);
    expect(disk).toBe('mine2');
  });

  it('写盘 await 期间继续键入 → markSaved 保留 dirty(并发键入语义不变)', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => (releaseWrite = r));
    const writeFile = vi.fn(async (_p: string, _c: string) => {
      await writeGate;
      return okWrite();
    });
    const deps: EditorFileDeps = {
      fs: { readFile: vi.fn(async () => okRead('orig')), writeFile },
      store: useEditorStore,
    };
    const p = saveFile('/x/a.md', deps);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
    useEditorStore.getState().updateContent('/x/a.md', 'mine+more');
    releaseWrite();
    expect((await p).ok).toBe(true);
    expect(tab()?.dirty).toBe(true);
    expect(tab()?.originalContent).toBe('mine');
  });
});

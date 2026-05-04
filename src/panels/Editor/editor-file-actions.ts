// M-Editor Step E2:文件操作纯函数。
// React hook(useEditorFile)是薄壳,业务逻辑都在这里,可单测。
//
// MVP 简化(详见 doc/09 § MVP 范围):
//  - 只实现 openFileByPath / saveFile
//  - 不做 Cmd+O / Cmd+N / 另存为(LayoutMotion fs IPC 暂无 open/saveDialog 通道)
//  - 新建/打开文件统一走 Explorer 右键菜单 + 单击

import type { FsApi } from '@/lib/fs/api';
import type { IpcResult } from '@/lib/fs/types';
import { createTab, useEditorStore } from '@/stores/editor.store';

export interface EditorFileDeps {
  fs: Pick<FsApi, 'readFile' | 'writeFile'>;
  /** 用注入便于 spec 复用同一全局 store. */
  store: typeof useEditorStore;
}

export type FileOpResult = IpcResult<void>;

const exception = (err: unknown): FileOpResult => ({
  ok: false,
  code: 'EXCEPTION',
  message: err instanceof Error ? err.message : String(err),
});

/**
 * Explorer 单击文件触发。已开过同 path → 只 switchTab(不重读);
 * 否则 fs.readFile + createTab + openTab。
 */
export async function openFileByPath(
  path: string,
  deps: EditorFileDeps,
): Promise<FileOpResult> {
  const { fs, store } = deps;
  // 已开过 → 只切换
  const existing = store.getState().tabs.find((t) => t.id === path);
  if (existing) {
    store.getState().switchTab(path);
    return { ok: true, data: undefined };
  }

  let r;
  try {
    r = await fs.readFile(path);
  } catch (err) {
    return exception(err);
  }
  if (!r.ok) return r;

  store.getState().openTab(createTab(path, r.data));
  return { ok: true, data: undefined };
}

/**
 * Cmd+S 触发。已存在 filePath 才能保存;无 path → UNSAVED_DRAFT(MVP 不支持另存为)。
 * 成功后 store.markSaved。
 */
export async function saveFile(
  tabId: string,
  deps: EditorFileDeps,
): Promise<FileOpResult> {
  const { fs, store } = deps;
  const tab = store.getState().tabs.find((t) => t.id === tabId);
  if (!tab) {
    return {
      ok: false,
      code: 'TAB_NOT_FOUND',
      message: `tab not found: ${tabId}`,
    };
  }
  if (!tab.filePath) {
    return {
      ok: false,
      code: 'UNSAVED_DRAFT',
      message: 'untitled draft cannot save without a path (MVP 不支持另存为)',
    };
  }

  let r;
  try {
    r = await fs.writeFile(tab.filePath, tab.content);
  } catch (err) {
    return exception(err);
  }
  if (!r.ok) return r;

  store.getState().markSaved(tabId);
  return { ok: true, data: undefined };
}

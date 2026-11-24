// M-Editor Step E2:useEditorFile 薄壳 hook。
// 把 editor-file-actions 纯函数包装,注入 deps(coApi.fs),
// 暴露给 EditorPanel / FolderTree / DockShell。

import { useMemo } from 'react';
import { useEditorStore } from '@/stores/editor.store';
import { openFileByPath as openFileByPathImpl, saveFile as saveFileImpl, type FileOpResult, type SaveFileOptions } from './editor-file-actions';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { editorFileDeps } from './editor-file-deps';

export interface EditorFileApi {
  /** Explorer 单击文件触发. 返 IpcResult,UI 决定如何提示. */
  openFileByPath: (path: string) => Promise<FileOpResult>;
  /** Cmd+S 触发. 磁盘被外部改过 → EDITOR_DISK_CHANGED. */
  saveActive: () => Promise<FileOpResult>;
  /** 按 tabId 保存(自动保存 / 确认覆盖用,不依赖当前 active tab). */
  saveTab: (tabId: string, opts?: SaveFileOptions) => Promise<FileOpResult>;
}

export function useEditorFile(): EditorFileApi {
  return useMemo<EditorFileApi>(() => {
    const deps = editorFileDeps;
    return {
      openFileByPath: (path) => openFileByPathImpl(path, deps),
      saveActive: async () => {
        const id = useEditorStore.getState().activeTabId;
        if (!id) {
          return { ok: false, code: 'NO_ACTIVE_TAB', message: 'no active tab' };
        }
        // 先把编辑器里尚未上抛的输入(Milkdown 自适应延迟上抛窗口)同步写回 store,本次保存才包含最后几键。
        // 只回写要保存的 tab(回写会整篇序列化)。
        flushEditorWriteBacks([id]);
        return saveFileImpl(id, deps);
      },
      saveTab: (tabId, opts) => saveFileImpl(tabId, deps, opts),
    };
  }, []);
}

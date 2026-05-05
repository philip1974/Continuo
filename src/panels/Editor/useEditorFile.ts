// M-Editor Step E2:useEditorFile 薄壳 hook。
// 把 editor-file-actions 纯函数包装,注入 deps(lmApi.fs + 全局 store),
// 暴露给 EditorPanel / Toolbar。

import { useMemo } from 'react';
import { lmApi } from '@/lib/lm-api';
import { useEditorStore } from '@/stores/editor.store';
import {
  openFileByPath as openFileByPathImpl,
  saveFile as saveFileImpl,
  type EditorFileDeps,
  type FileOpResult,
} from './editor-file-actions';

export interface EditorFileApi {
  /** Explorer 单击文件触发. 返 IpcResult,UI 决定如何提示. */
  openFileByPath: (path: string) => Promise<FileOpResult>;
  /** Cmd+S 触发. activeTab 没有 path → 返 UNSAVED_DRAFT. */
  saveActive: () => Promise<FileOpResult>;
}

export function useEditorFile(): EditorFileApi {
  return useMemo<EditorFileApi>(() => {
    const deps: EditorFileDeps = {
      fs: {
        readFile: (p) => lmApi.fs.readFile(p),
        writeFile: (p, c) => lmApi.fs.writeFile(p, c),
      },
      store: useEditorStore,
    };
    return {
      openFileByPath: (path) => openFileByPathImpl(path, deps),
      saveActive: async () => {
        const id = useEditorStore.getState().activeTabId;
        if (!id) {
          return { ok: false, code: 'NO_ACTIVE_TAB', message: 'no active tab' };
        }
        return saveFileImpl(id, deps);
      },
    };
  }, []);
}

// 外部进程修改文件时,自动同步打开的 editor tab 内容。
//
// 触发源:Explorer 已展开目录被 fs.watch 监听,main 进程 broadcast
// `fs:dir-changed`。本 hook 订阅该事件,扫描已打开 tabs,命中父目录的
// 重读磁盘并通过 store.reloadFromDisk 同步。dirty tab 跳过,保护用户编辑。
//
// 注意:本 hook 不主动 watchDir,完全复用 Explorer 已 watch 的目录列表。
// 父目录未展开的文件收不到通知(用户需手动刷新);95% 场景下打开文件
// 之前 Explorer 已展开/reveal 过该路径。

import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { useEditorStore } from '@/stores/editor.store';

function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(0, idx) : '';
}

export function useExternalFileSync(): void {
  useEffect(() => {
    const unsub = coApi.fs.onDirChanged((changedDir) => {
      const tabs = useEditorStore.getState().tabs;
      for (const tab of tabs) {
        if (tab.filePath === null) continue;
        if (tab.dirty) continue; // 保留用户改动,不覆盖
        if (dirname(tab.filePath) !== changedDir) continue;
        const path = tab.filePath;
        const tabId = tab.id;
        void coApi.fs.readFile(path).then((r) => {
          if (!r.ok) return; // 文件被删或暂时不可读,跳过
          useEditorStore.getState().reloadFromDisk(tabId, r.data);
        });
      }
    });
    return unsub;
  }, []);
}

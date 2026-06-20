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
    // 同一 path 在短时间内多次变更会广播多个 dir-changed → 对该 path 发起
    // 多个并发、未防抖、未序列化的 readFile。这些 Promise 可能乱序 resolve:
    // 较早发起、读到旧内容的回调若后 resolve,会用陈旧内容覆盖较新内容调
    // reloadFromDisk(editor 显示回退到旧版本)。每 path 维护单调 seq,只让最新
    // 一轮读的结果落地(latest-wins),丢弃过期回调。
    const seqByPath = new Map<string, number>();
    const unsub = coApi.fs.onDirChanged((changedDir) => {
      const tabs = useEditorStore.getState().tabs;
      for (const tab of tabs) {
        if (tab.filePath === null) continue;
        if (tab.dirty) continue; // 保留用户改动,不覆盖
        if (dirname(tab.filePath) !== changedDir) continue;
        const path = tab.filePath;
        const tabId = tab.id;
        const mySeq = (seqByPath.get(path) ?? 0) + 1;
        seqByPath.set(path, mySeq);
        void coApi.fs.readFile(path).then((r) => {
          if (mySeq !== seqByPath.get(path)) return; // 已有更新一轮读发起,丢弃过期结果
          if (!r.ok) return; // 文件被删或暂时不可读,跳过
          useEditorStore.getState().reloadFromDisk(tabId, r.data);
        });
      }
    });
    return unsub;
  }, []);
}
